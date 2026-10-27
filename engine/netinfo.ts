/**
 * IP-layer diagnostics: addresses, gateway, DNS, router MAC and ping telemetry.
 */

import { networkInterfaces } from "node:os";
import { readFileSync } from "node:fs";
import type { PingStat } from "./types";
import { normalizeMac } from "./rf";
import { run } from "./sources/source";

export interface NetInfo {
  ip: string | null;
  ipv6: string | null;
  gateway: string | null;
  gatewayIface: string | null;
  routerMac: string | null;
  dns: string[];
}

const platform = process.platform;

export async function readNetInfo(preferredIface: string | null): Promise<NetInfo> {
  let gateway: string | null = null;
  let gatewayIface: string | null = null;

  if (platform === "darwin") {
    const out = await run(["route", "-n", "get", "default"], 3000);
    gateway = out.match(/gateway:\s*(\S+)/)?.[1] ?? null;
    gatewayIface = out.match(/interface:\s*(\S+)/)?.[1] ?? null;
  } else if (platform === "linux") {
    const out = await run(["ip", "route", "show", "default"], 3000);
    gateway = out.match(/via\s+(\S+)/)?.[1] ?? null;
    gatewayIface = out.match(/dev\s+(\S+)/)?.[1] ?? null;
  } else if (platform === "win32") {
    const out = await run(["route", "print", "0.0.0.0"], 5000);
    gateway = out.match(/0\.0\.0\.0\s+0\.0\.0\.0\s+(\d+\.\d+\.\d+\.\d+)/)?.[1] ?? null;
  }

  const ifaces = networkInterfaces();
  const name = preferredIface && ifaces[preferredIface] ? preferredIface : gatewayIface;
  const addrs = (name && ifaces[name]) || Object.values(ifaces).flat().filter((a) => a && !a.internal);
  const v4 = addrs?.find((a) => a && a.family === "IPv4" && !a.internal);
  const v6 =
    addrs?.find((a) => a && a.family === "IPv6" && !a.internal && !a.address.startsWith("fe80")) ??
    addrs?.find((a) => a && a.family === "IPv6" && !a.internal);

  let routerMac: string | null = null;
  if (gateway && /^\d+\.\d+\.\d+\.\d+$/.test(gateway)) {
    // Linux: iproute2 is always there (used above); `arp` needs net-tools, often not installed.
    const cmd =
      platform === "win32" ? ["arp", "-a", gateway] : platform === "linux" ? ["ip", "neigh", "show", gateway] : ["arp", "-n", gateway];
    const out = await run(cmd, 3000);
    const m = out.match(/([0-9a-f]{1,2}[:-]){5}[0-9a-f]{1,2}/i)?.[0];
    if (m) routerMac = normalizeMac(m.split(/[:-]/).map((o) => o.padStart(2, "0")).join(":"));
  }

  return { ip: v4?.address ?? null, ipv6: v6?.address ?? null, gateway, gatewayIface, routerMac, dns: await readDns() };
}

async function readDns(): Promise<string[]> {
  let text = "";
  if (platform === "darwin") text = await run(["scutil", "--dns"], 3000);
  else if (platform === "linux") {
    try {
      text = readFileSync("/etc/resolv.conf", "utf8");
    } catch {
      text = "";
    }
  } else return [];
  const found = [...text.matchAll(/nameserver(?:\[\d+\])?\s*:?\s*(\S+)/g)].map((m) => m[1]);
  const unique = [...new Set(found)];
  return [...unique.filter((d) => !d.includes(":")), ...unique.filter((d) => d.includes(":"))].slice(0, 4);
}

// ─── Ping ──────────────────────────────────────────────────────────────────

const WINDOW = 60;

export class PingMonitor {
  private samples: (number | null)[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private inflight = false;

  constructor(
    public target: string | null,
    private everyMs: number,
  ) {}

  start() {
    this.timer = setInterval(() => this.tick(), this.everyMs);
    this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  setTarget(target: string | null) {
    if (target !== this.target) {
      this.target = target;
      this.samples = [];
    }
  }

  /** Lets the demo source feed synthetic samples. */
  push(sample: number | null) {
    this.samples.push(sample);
    if (this.samples.length > WINDOW) this.samples.shift();
  }

  private async tick() {
    if (!this.target || this.inflight) return;
    this.inflight = true;
    const cmd =
      platform === "win32"
        ? ["ping", "-n", "1", "-w", "1500", this.target]
        : platform === "darwin"
          ? ["ping", "-c", "1", "-t", "2", this.target]
          : ["ping", "-c", "1", "-W", "2", this.target];
    const out = await run(cmd, 3500);
    const m = out.match(/(?:time|tempo)[=<]\s*([\d.,]+)\s*ms/i);
    this.push(m ? parseFloat(m[1].replace(",", ".")) : null);
    this.inflight = false;
  }

  /** Consecutive timeouts at the end of the window. */
  get trailingLoss(): number {
    let n = 0;
    for (let i = this.samples.length - 1; i >= 0 && this.samples[i] === null; i--) n++;
    return n;
  }

  stat(): PingStat {
    const ok = this.samples.filter((s): s is number => s !== null);
    const recent = ok.slice(-20);
    let jitter: number | null = null;
    if (recent.length > 1) {
      let sum = 0;
      for (let i = 1; i < recent.length; i++) sum += Math.abs(recent[i] - recent[i - 1]);
      jitter = sum / (recent.length - 1);
    }
    return {
      target: this.target,
      last: this.samples.length ? (this.samples[this.samples.length - 1] ?? null) : null,
      avg: ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : null,
      min: ok.length ? Math.min(...ok) : null,
      max: ok.length ? Math.max(...ok) : null,
      jitter,
      loss: this.samples.length ? 1 - ok.length / this.samples.length : 0,
      history: [...this.samples],
    };
  }
}
