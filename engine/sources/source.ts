/**
 * Scan source contract + small process helpers shared by platform adapters.
 */

import type { RawLink, RawObservation, ScanBatch, SourceStatus } from "../types";

export interface SourceHandlers {
  onScan(batch: ScanBatch, provisional?: boolean): void;
  onLink(link: RawLink | null): void;
  onStatus(status: SourceStatus): void;
  onError(message: string): void;
}

export interface ScanSource {
  readonly status: SourceStatus;
  start(handlers: SourceHandlers): Promise<void>;
  stop(): void;
}

export interface Observation extends RawObservation {
  vendorHint?: string | null;
}

/** Raw stdout bytes, for tools whose output is not UTF-8 (e.g. netsh in the OEM code page). */
export async function runBytes(cmd: string[], timeoutMs = 15000): Promise<Uint8Array> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const bytes = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
    clearTimeout(timer);
    await proc.exited;
    return bytes;
  } catch {
    return new Uint8Array();
  }
}

export async function run(cmd: string[], timeoutMs = 15000): Promise<string> {
  return new TextDecoder().decode(await runBytes(cmd, timeoutMs));
}

export function which(binary: string): boolean {
  return Bun.which(binary) !== null;
}

export function emptyLink(): RawLink {
  return {
    iface: null,
    ssid: null,
    bssid: null,
    rssi: null,
    noise: null,
    txRate: null,
    mcs: null,
    channel: null,
    band: null,
    width: null,
    phy: null,
    security: null,
    txPower: null,
    mac: null,
    country: null,
  };
}

/** netsh's 0-100 signal quality: 0% = -100 dBm, 100% = -50 dBm. */
export const percentToDbm = (pct: number) => Math.round(pct / 2 - 100);

/** Inverse of NetworkManager's nm_wifi_utils_level_to_quality (-100..-40 dBm → 0..100%). */
export const nmPercentToDbm = (pct: number) => Math.round(-100 + 0.6 * Math.min(Math.max(pct, 0), 100));

export function securityFromText(text: string): string[] {
  const t = text.toLowerCase();
  const tokens = new Set<string>();
  if (!t || t === "--" || t.includes("open") || t.includes("abert") || t === "none") tokens.add("open");
  if (t.includes("wep")) tokens.add("wep");
  if (/wpa3/.test(t)) tokens.add(t.includes("enterprise") || t.includes("802.1x") ? "wpa3e" : "wpa3");
  if (/wpa2/.test(t)) tokens.add(t.includes("enterprise") || t.includes("802.1x") ? "wpa2e" : "wpa2");
  if (/wpa1|wpa(?![23])/.test(t)) tokens.add("wpa");
  if (t.includes("owe")) tokens.add("owe");
  if (tokens.size > 1) tokens.delete("open");
  if (tokens.has("wpa3") && tokens.has("wpa2")) tokens.add("wpa3t");
  return [...tokens];
}
