/**
 * macOS source: a small CoreWLAN helper (compiled on first run with swiftc) streams
 * scans + link telemetry. Falls back to `system_profiler` when no Swift toolchain exists.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess, UnixSocketListener } from "bun";
import type { Band, RawLink, SourceStatus } from "../types";
import { fnv1a, normalizeMac } from "../rf";
import { emptyLink, run, type Observation, type ScanSource, type SourceHandlers } from "./source";

const SRC_DIR = join(import.meta.dir, "macos");
const CACHE_DIR = process.env.WI_CACHE_DIR || join(import.meta.dir, "..", "..", ".cache");
export const HELPER_APP = join(CACHE_DIR, "WiScan.app");
export const HELPER_BIN = join(HELPER_APP, "Contents", "MacOS", "wiscan");
const HASH_FILE = join(CACHE_DIR, "wiscan.hash");

function sourceHash(): string {
  const swift = readFileSync(join(SRC_DIR, "WiScan.swift"), "utf8");
  const plist = readFileSync(join(SRC_DIR, "Info.plist"), "utf8");
  return fnv1a(swift + plist).toString(16);
}

export function helperIsBuilt(): boolean {
  return existsSync(HELPER_BIN) && existsSync(HASH_FILE) && readFileSync(HASH_FILE, "utf8") === sourceHash();
}

/**
 * /usr/bin/swiftc is an xcrun shim that exists even without a toolchain (and running it
 * pops the CLT installer), so look for a real swiftc in the active developer dir instead.
 */
async function hasSwiftc(): Promise<boolean> {
  const found = Bun.which("swiftc");
  if (found && found !== "/usr/bin/swiftc") return true;
  const dev = (await run(["xcode-select", "-p"], 5000)).trim();
  if (!dev) return false;
  return [join(dev, "usr", "bin", "swiftc"), join(dev, "Toolchains", "XcodeDefault.xctoolchain", "usr", "bin", "swiftc")]
    .some((p) => existsSync(p));
}

/** CoreWLAN may omit leading zeros in octets ("0:1a:…"), which normalizeMac would reject. */
function macOf(s: unknown): string | null {
  return typeof s === "string" ? normalizeMac(s.split(":").map((o) => o.padStart(2, "0")).join(":")) : null;
}

/** Builds the helper app bundle. Returns null on success, or an error message. */
export async function buildHelper(log: (msg: string) => void = () => {}): Promise<string | null> {
  if (helperIsBuilt()) return null;
  if (!(await hasSwiftc())) return "swiftc não encontrado (instale as Command Line Tools: xcode-select --install)";

  log("compilando helper CoreWLAN (só na primeira vez, ~20s)…");
  mkdirSync(join(HELPER_APP, "Contents", "MacOS"), { recursive: true });
  const plist = join(SRC_DIR, "Info.plist");
  const proc = Bun.spawn(
    [
      "swiftc", "-O", join(SRC_DIR, "WiScan.swift"), "-o", HELPER_BIN,
      "-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", plist,
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  const stderr = await new Response(proc.stderr).text();
  if ((await proc.exited) !== 0) return `falha ao compilar helper: ${stderr.split("\n").find((l) => l.includes("error")) ?? stderr.slice(0, 200)}`;

  writeFileSync(join(HELPER_APP, "Contents", "Info.plist"), readFileSync(plist));
  await run(["codesign", "--force", "-s", "-", HELPER_APP], 30000);
  writeFileSync(HASH_FILE, sourceHash());
  return null;
}

interface HelperNetwork {
  ssid?: string;
  bssid?: string;
  rssi: number;
  noise: number;
  channel: number;
  band?: Band;
  width?: number;
  beacon: number;
  security: string[];
  phy: string[];
}

export class MacSource implements ScanSource {
  status: SourceStatus = { kind: "macos", label: "macOS · CoreWLAN", redacted: true, note: null };
  private proc: Subprocess | null = null;
  private listener: UnixSocketListener<undefined> | null = null;
  private socketPath = join(tmpdir(), `wiscan-${process.pid}.sock`);
  private stopped = false;
  private restarts = 0;
  private profilerTimer: ReturnType<typeof setInterval> | null = null;
  private mcs: number | null = null;

  constructor(private intervalSec = 2) {}

  async start(h: SourceHandlers) {
    const err = await buildHelper((m) => h.onError(m));
    if (err) throw new Error(err);
    this.spawn(h);
    // CoreWLAN does not expose MCS; system_profiler does (slowly), so poll it rarely.
    const pollMcs = async () => {
      const text = await run(["system_profiler", "SPAirPortDataType", "-json"], 30000);
      try {
        const iface = JSON.parse(text).SPAirPortDataType[0].spairport_airport_interfaces[0];
        this.mcs = iface?.spairport_current_network_information?.spairport_network_mcs ?? null;
      } catch {
        // keep last value
      }
    };
    pollMcs();
    this.profilerTimer = setInterval(pollMcs, 60000);
  }

  private async spawn(h: SourceHandlers) {
    if (this.stopped) return;
    if (!(await this.spawnViaLaunchServices(h))) this.spawnDirect(h);
  }

  private restart(h: SourceHandlers, why: string) {
    if (this.stopped) return;
    h.onError(`helper CoreWLAN ${why}, reiniciando…`);
    if (++this.restarts < 20) setTimeout(() => this.spawn(h), 2000);
  }

  /**
   * Launching through LaunchServices makes WiScan.app its own "responsible process",
   * so a Location grant (`wi authorize`) applies and SSIDs/BSSIDs are revealed.
   * The helper streams into a Unix socket and exits as soon as the socket closes.
   */
  private spawnViaLaunchServices(h: SourceHandlers): Promise<boolean> {
    rmSync(this.socketPath, { force: true });
    return new Promise((resolve) => {
      let settled = false;
      let buf = "";
      // Lines exceed the 8 KB socket buffer, so chunks can split multi-byte UTF-8 SSIDs.
      const decoder = new TextDecoder();
      const settle = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!ok) this.listener?.stop(true);
        resolve(ok);
      };
      try {
        this.listener = Bun.listen({
          unix: this.socketPath,
          socket: {
            open: () => settle(true),
            data: (_sock, data) => {
              buf += decoder.decode(data, { stream: true });
              buf = this.drainLines(buf, h);
            },
            close: () => {
              this.listener?.stop(true);
              this.restart(h, "desconectou");
            },
          },
        });
      } catch {
        return resolve(false);
      }
      const timer = setTimeout(() => settle(false), 5000);
      Bun.spawn(["open", "-n", "-g", HELPER_APP, "--args", "stream", String(this.intervalSec), "--socket", this.socketPath], {
        stdout: "ignore",
        stderr: "ignore",
      }).exited.then((code) => code !== 0 && settle(false));
    });
  }

  private spawnDirect(h: SourceHandlers) {
    const proc = Bun.spawn([HELPER_BIN, "stream", String(this.intervalSec)], {
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
    });
    this.proc = proc;
    (async () => {
      const decoder = new TextDecoder();
      let buf = "";
      for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
        buf = this.drainLines(buf + decoder.decode(chunk, { stream: true }), h);
      }
    })();
    proc.exited.then((code) => this.restart(h, `saiu (código ${code})`));
  }

  /** Handles every complete line in `buf` and returns the incomplete remainder. */
  private drainLines(buf: string, h: SourceHandlers): string {
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) this.handleLine(line, h);
    }
    return buf;
  }

  private handleLine(line: string, h: SourceHandlers) {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    switch (msg.type) {
      case "hello":
      case "auth": {
        const redacted = msg.auth !== "authorized";
        this.status = {
          ...this.status,
          redacted,
          note: redacted ? "macOS oculta SSID/BSSID sem permissão de Localização — rode `bun run authorize`" : null,
        };
        h.onStatus(this.status);
        break;
      }
      case "scan": {
        // Throttled scans are answered from the OS cache (see WiScan.swift); skip them.
        if (!msg.cached && msg.durationMs < 1000) return;
        const seen = new Set<string>();
        const networks: Observation[] = (msg.networks as HelperNetwork[])
          .filter((n) => n.channel > 0 && n.rssi < 0)
          // The cached first paint repeats the same BSS across older scans; collapse exact twins.
          .filter((n) => {
            if (!msg.cached || n.ssid || n.bssid) return true;
            const key = [n.band, n.channel, n.width, n.rssi, n.beacon, n.security.join("+"), n.phy.join("+")].join("|");
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          })
          .map((n) => ({
            ssid: n.ssid ?? null,
            bssid: macOf(n.bssid),
            rssi: n.rssi,
            noise: n.noise && n.noise < 0 ? n.noise : null,
            channel: n.channel,
            band: n.band ?? (n.channel <= 14 ? "2.4" : "5"),
            width: n.width ?? 20,
            security: n.security,
            phy: n.phy,
            beaconInterval: n.beacon || null,
          }));
        if (networks.some((n) => n.ssid || n.bssid) && this.status.redacted) {
          this.status = { ...this.status, redacted: false, note: null };
          h.onStatus(this.status);
        }
        h.onScan({ networks, durationMs: msg.durationMs }, msg.cached);
        break;
      }
      case "link": {
        if (!msg.associated) return h.onLink(null);
        const link: RawLink = {
          ...emptyLink(),
          iface: msg.iface ?? null,
          ssid: msg.ssid ?? null,
          bssid: macOf(msg.bssid),
          rssi: msg.rssi ?? null,
          noise: msg.noise ?? null,
          txRate: msg.txRate ?? null,
          mcs: this.mcs,
          channel: msg.channel ?? null,
          band: msg.band ?? null,
          width: msg.width ?? null,
          phy: msg.phy ?? null,
          security: msg.security ?? null,
          mac: msg.mac ?? null,
          country: msg.country ?? null,
        };
        h.onLink(link);
        break;
      }
      case "error":
        h.onError(`CoreWLAN: ${msg.message}`);
        break;
    }
  }

  stop() {
    this.stopped = true;
    this.proc?.kill();
    this.listener?.stop(true); // the helper exits on its next write
    rmSync(this.socketPath, { force: true });
    if (this.profilerTimer) clearInterval(this.profilerTimer);
  }
}

/** Slow fallback: parses `system_profiler SPAirPortDataType -json` (signal only for few networks). */
export class MacProfilerSource implements ScanSource {
  status: SourceStatus = {
    kind: "macos-profiler",
    label: "macOS · system_profiler",
    redacted: true,
    note: "Modo limitado: instale as Command Line Tools (xcode-select --install) para o scanner CoreWLAN",
  };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(private intervalSec = 5) {}

  async start(h: SourceHandlers) {
    h.onStatus(this.status);
    const tick = async () => {
      const t0 = Date.now();
      const text = await run(["system_profiler", "SPAirPortDataType", "-json"], 40000);
      if (this.stopped) return;
      try {
        const iface = JSON.parse(text).SPAirPortDataType[0].spairport_airport_interfaces[0];
        const parseSignal = (s?: string) => {
          const m = s?.match(/(-?\d+) dBm \/ (-?\d+) dBm/);
          return m ? { rssi: Number(m[1]), noise: Number(m[2]) } : null;
        };
        const parseChannel = (s: string) => {
          const m = s.match(/^(\d+) \((\d)GHz(?:, (\d+)MHz)?\)/);
          if (!m) return null;
          const band: Band = m[2] === "2" ? "2.4" : (m[2] as Band);
          return { channel: Number(m[1]), band, width: Number(m[3] ?? 20) };
        };
        const toObs = (n: any): Observation | null => {
          const sig = parseSignal(n.spairport_signal_noise);
          const ch = parseChannel(n.spairport_network_channel ?? "");
          if (!sig || !ch) return null;
          const name = n._name && n._name !== "<redacted>" ? n._name : null;
          const sec = String(n.spairport_security_mode ?? "");
          return {
            ssid: name,
            bssid: null,
            rssi: sig.rssi,
            noise: sig.noise,
            ...ch,
            security: sec.includes("wpa3") ? ["wpa3"] : sec.includes("wpa2") ? ["wpa2"] : sec.includes("none") ? ["open"] : [],
            phy: String(n.spairport_network_phymode ?? "").replace("802.11", "").split("/").filter(Boolean),
            beaconInterval: null,
          };
        };
        const current = iface.spairport_current_network_information;
        const others = (iface.spairport_airport_other_local_wireless_networks ?? []).map(toObs).filter(Boolean);
        const cur = current ? toObs(current) : null;
        h.onScan({ networks: [...(cur ? [cur] : []), ...others] as Observation[], durationMs: Date.now() - t0 });
        if (cur) {
          h.onLink({
            ...emptyLink(),
            iface: iface._name,
            rssi: cur.rssi,
            noise: cur.noise,
            txRate: current.spairport_network_rate ?? null,
            mcs: current.spairport_network_mcs ?? null,
            channel: cur.channel,
            band: cur.band,
            width: cur.width,
            phy: cur.phy.at(-1) ?? null,
            security: cur.security[0] ?? null,
          });
        } else h.onLink(null);
      } catch (e) {
        h.onError(`system_profiler: ${(e as Error).message}`);
      }
      this.timer = setTimeout(tick, this.intervalSec * 1000);
    };
    tick();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }
}

/** Opens the helper through LaunchServices so macOS shows the Location prompt for it. */
export async function authorizeHelper(log: (msg: string) => void): Promise<string> {
  const err = await buildHelper(log);
  if (err) throw new Error(err);
  const outFile = join(CACHE_DIR, "authorize.out");
  writeFileSync(outFile, "");
  const proc = Bun.spawn(["open", "-W", "-n", "--stdout", outFile, HELPER_APP, "--args", "authorize"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  await proc.exited;
  const text = readFileSync(outFile, "utf8").trim().split("\n").pop() ?? "";
  try {
    return JSON.parse(text).auth ?? "unknown";
  } catch {
    return "unknown";
  }
}
