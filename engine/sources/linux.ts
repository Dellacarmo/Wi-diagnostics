/**
 * Linux source: NetworkManager (`nmcli`) for scans, `iw` for precise link telemetry.
 */

import type { Band, RawLink, SourceStatus } from "../types";
import { bandFromFrequency, channelFromFrequency, normalizeMac } from "../rf";
import {
  emptyLink, nmPercentToDbm, run, securityFromText, which,
  type Observation, type ScanSource, type SourceHandlers,
} from "./source";

function splitTerse(line: string): string[] {
  const fields: string[] = [];
  let cur = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\\" && i + 1 < line.length) {
      cur += line[++i];
    } else if (ch === ":") {
      fields.push(cur);
      cur = "";
    } else cur += ch;
  }
  fields.push(cur);
  return fields.map((f) => f.trim());
}

export class LinuxSource implements ScanSource {
  status: SourceStatus = { kind: "linux", label: "Linux · nmcli", redacted: false, note: null };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private linkTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private withBandwidth = true;
  private iface: string | null = null;

  constructor(private intervalSec = 3, iface: string | null = null) {
    this.iface = iface;
  }

  async start(h: SourceHandlers) {
    if (!which("nmcli")) throw new Error("nmcli não encontrado (NetworkManager)");
    h.onStatus(this.status);
    if (!this.iface) {
      const dev = await run(["nmcli", "-t", "-f", "DEVICE,TYPE", "dev", "status"]);
      this.iface = dev.split("\n").map(splitTerse).find((f) => f[1] === "wifi")?.[0] ?? null;
    }

    const scan = async () => {
      const t0 = Date.now();
      const networks = await this.scan();
      if (this.stopped) return;
      h.onScan({ networks, durationMs: Date.now() - t0 });
      this.timer = setTimeout(scan, this.intervalSec * 1000);
    };
    scan();

    const link = async () => h.onLink(await this.link());
    link();
    this.linkTimer = setInterval(link, 1000);
  }

  private async scan(): Promise<Observation[]> {
    const fields = `IN-USE,SSID,BSSID,SIGNAL,FREQ,CHAN,SECURITY${this.withBandwidth ? ",BANDWIDTH" : ""}`;
    const cmd = ["nmcli", "-t", "-e", "yes", "-f", fields, "dev", "wifi", "list", "--rescan", "auto"];
    if (this.iface) cmd.push("ifname", this.iface);
    const out = await run(cmd, 30000);
    if (!out.trim() && this.withBandwidth) {
      // Older nmcli rejects BANDWIDTH, but an empty list may also mean radio off or no
      // results yet: keep the fallback only if the retry without it returns rows.
      this.withBandwidth = false;
      const retry = await this.scan();
      if (!retry.length) this.withBandwidth = true;
      return retry;
    }
    const result: Observation[] = [];
    for (const line of out.split("\n")) {
      const f = splitTerse(line);
      if (f.length < 7) continue;
      const bssid = normalizeMac(f[2]);
      if (!bssid) continue;
      const freq = parseInt(f[4], 10) || 2412;
      const band: Band = bandFromFrequency(freq);
      result.push({
        ssid: f[1] || null,
        bssid,
        rssi: nmPercentToDbm(Number(f[3]) || 0),
        noise: null,
        channel: parseInt(f[5], 10) || channelFromFrequency(freq),
        band,
        width: parseInt(f[7] ?? "", 10) || 20,
        security: securityFromText(f[6]),
        phy: [],
        beaconInterval: null,
      });
    }
    return result;
  }

  private async link(): Promise<RawLink | null> {
    if (this.iface && which("iw")) {
      const out = await run(["iw", "dev", this.iface, "link"], 3000);
      if (out.includes("Not connected") || !out.trim()) return null;
      const get = (re: RegExp) => out.match(re)?.[1] ?? null;
      const freq = Number(get(/freq:\s*([\d.]+)/));
      const tx = get(/tx bitrate:\s*([\d.]+)/);
      const txLine = get(/tx bitrate:(.*)/) ?? "";
      const phy = /EHT/.test(txLine) ? "be" : /HE-/.test(txLine) ? "ax" : /VHT/.test(txLine) ? "ac" : /MCS/.test(txLine) ? "n" : null;
      const mcs = txLine.match(/MCS\s+(\d+)/)?.[1];
      // iw runs in the C locale and prints every non-ASCII SSID byte as \xNN.
      const rawSsid = get(/SSID:[ \t]*(.*)/);
      const ssid = !rawSsid ? null : new TextDecoder().decode(
        Uint8Array.from(rawSsid.replace(/\\x([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))), (c) => c.charCodeAt(0)),
      );
      return {
        ...emptyLink(),
        iface: this.iface,
        ssid,
        bssid: normalizeMac(get(/Connected to ([0-9a-f:]{17})/i)),
        rssi: Number(get(/signal:\s*(-?\d+)/)) || null,
        txRate: tx ? Number(tx) : null,
        mcs: mcs === undefined ? null : Number(mcs),
        channel: freq ? channelFromFrequency(freq) : null,
        band: freq ? bandFromFrequency(freq) : null,
        width: Number(get(/(\d+)MHz/)) || null,
        phy,
      };
    }
    // Fallback: the in-use row from nmcli
    const out = await run(["nmcli", "-t", "-e", "yes", "-f", "IN-USE,SSID,BSSID,SIGNAL,FREQ,CHAN,SECURITY", "dev", "wifi"]);
    const row = out.split("\n").map(splitTerse).find((f) => f[0] === "*");
    if (!row) return null;
    const freq = parseInt(row[4], 10);
    return {
      ...emptyLink(),
      iface: this.iface,
      ssid: row[1] || null,
      bssid: normalizeMac(row[2]),
      rssi: nmPercentToDbm(Number(row[3]) || 0),
      channel: parseInt(row[5], 10) || null,
      band: freq ? bandFromFrequency(freq) : null,
      security: securityFromText(row[6]).at(-1) ?? null,
    };
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.linkTimer) clearInterval(this.linkTimer);
  }
}
