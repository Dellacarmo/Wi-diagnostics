/**
 * RF math: channel plans, spectrum spans, path-loss distance, filters, grading.
 */

import type { Band, DistanceEstimate, EnvironmentModel, EnvironmentPreset } from "./types";

// ─── Environment presets (log-distance path loss) ─────────────────────────

export const ENVIRONMENTS: Record<EnvironmentPreset, EnvironmentModel> = {
  open: { preset: "open", label: "Espaço aberto", exponent: 2.2, shadowing: 3 },
  residential: { preset: "residential", label: "Residencial", exponent: 3.0, shadowing: 5 },
  office: { preset: "office", label: "Escritório", exponent: 3.4, shadowing: 6 },
  dense: { preset: "dense", label: "Prédio denso", exponent: 3.8, shadowing: 7 },
};

export const ENV_ORDER: EnvironmentPreset[] = ["open", "residential", "office", "dense"];

/** Expected RSSI at 1 m. Higher bands lose more in free space (FSPL @1m: 40/46/48 dB). */
const REF_RSSI_1M: Record<Band, number> = { "2.4": -30, "5": -36, "6": -38 };

export function estimateDistance(
  rssi: number,
  band: Band,
  env: EnvironmentModel,
  rssiStd = 0,
): DistanceEstimate {
  const n = env.exponent;
  const a = REF_RSSI_1M[band];
  const clamp = (d: number) => Math.min(Math.max(d, 0.3), 250);
  const est = clamp(Math.pow(10, (a - rssi) / (10 * n)));
  const sigma = Math.sqrt(env.shadowing ** 2 + rssiStd ** 2);
  const spread = Math.pow(10, sigma / (10 * n));
  return { est, min: clamp(est / spread), max: clamp(est * spread) };
}

/** Predicted RSSI at a given distance — used for coverage fields. */
export function predictRssi(distance: number, band: Band, env: EnvironmentModel): number {
  return REF_RSSI_1M[band] - 10 * env.exponent * Math.log10(Math.max(distance, 0.3));
}

// ─── Channel plans ────────────────────────────────────────────────────────

export function channelFrequency(channel: number, band: Band): number {
  if (band === "2.4") return channel === 14 ? 2484 : 2407 + 5 * channel;
  if (band === "5") return 5000 + 5 * channel;
  return channel === 2 ? 5935 : 5950 + 5 * channel;
}

export function bandFromFrequency(freq: number): Band {
  if (freq < 3000) return "2.4";
  if (freq < 5925) return "5";
  return "6";
}

export function bandFromChannel(channel: number, hint?: Band | null): Band {
  if (hint) return hint;
  return channel <= 14 ? "2.4" : "5";
}

export function channelFromFrequency(freq: number): number {
  if (freq === 2484) return 14;
  if (freq < 3000) return Math.round((freq - 2407) / 5);
  if (freq < 5925) return Math.round((freq - 5000) / 5);
  if (freq === 5935) return 2;
  return Math.round((freq - 5950) / 5);
}

const FIVE_GHZ_BLOCKS: Record<number, number[]> = {
  40: [36, 44, 52, 60, 100, 108, 116, 124, 132, 140, 149, 157, 165, 173],
  80: [36, 52, 100, 116, 132, 149, 165],
  160: [36, 100, 149],
};

/** Occupied spectrum [lo, hi] in MHz for a (possibly bonded) channel. */
export function channelSpan(channel: number, band: Band, width: number): [number, number] {
  const primary = channelFrequency(channel, band);
  if (band === "2.4") {
    // 802.11b/g/n 20 MHz masks are ~22 MHz wide; 40 MHz bonds up for low channels.
    if (width >= 40) {
      const center = channel <= 7 ? primary + 10 : primary - 10;
      return [center - 20, center + 20];
    }
    return [primary - 11, primary + 11];
  }

  const w = Math.max(20, width);
  if (w === 20) return [primary - 10, primary + 10];

  if (band === "5") {
    const blocks = FIVE_GHZ_BLOCKS[w];
    const steps = w / 20;
    const start = blocks?.find((s) => channel >= s && channel < s + 4 * steps);
    if (start !== undefined) {
      const center = channelFrequency(start + 2 * (steps - 1), band);
      return [center - w / 2, center + w / 2];
    }
    return [primary - w / 2, primary + w / 2];
  }

  // 6 GHz: 20 MHz channels at 1, 5, 9…; bonded blocks are aligned groups.
  const k = w / 20;
  const idx = Math.floor((channel - 1) / 4);
  const startIdx = Math.floor(idx / k) * k;
  const centerCh = 1 + 4 * (startIdx + (k - 1) / 2);
  const center = channelFrequency(centerCh, band);
  return [center - w / 2, center + w / 2];
}

export const BAND_RANGES: Record<Band, [number, number]> = {
  "2.4": [2401, 2495],
  "5": [5170, 5895],
  "6": [5925, 7125],
};

export const BAND_CHANNELS: Record<Band, number[]> = {
  "2.4": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
  "5": [36, 40, 44, 48, 52, 56, 60, 64, 100, 104, 108, 112, 116, 120, 124, 128, 132, 136, 140, 144, 149, 153, 157, 161, 165],
  "6": Array.from({ length: 59 }, (_, i) => 1 + i * 4),
};

/** DFS channels require radar detection — worth surfacing in diagnostics. */
export function isDfs(channel: number, band: Band): boolean {
  return band === "5" && channel >= 52 && channel <= 144;
}

// ─── Signal helpers ───────────────────────────────────────────────────────

export const dbmToMw = (dbm: number) => Math.pow(10, dbm / 10);
export const mwToDbm = (mw: number) => 10 * Math.log10(Math.max(mw, 1e-12));

export function signalQuality(rssi: number, snr: number | null = null): number {
  const fromRssi = Math.min(Math.max(((rssi + 92) / 62) * 100, 0), 100);
  if (snr === null) return Math.round(fromRssi);
  const fromSnr = Math.min(Math.max(((snr - 5) / 40) * 100, 0), 100);
  return Math.round(fromRssi * 0.55 + fromSnr * 0.45);
}

export function rssiLabel(rssi: number): string {
  if (rssi >= -55) return "excelente";
  if (rssi >= -67) return "bom";
  if (rssi >= -75) return "razoável";
  if (rssi >= -82) return "fraco";
  return "crítico";
}

/** 1-D Kalman filter tuned for RSSI jitter. */
export class Kalman {
  private x: number | null = null;
  private p = 1;
  constructor(
    private q = 0.6, // process noise
    private r = 6, // measurement noise
  ) {}
  update(z: number): number {
    if (this.x === null) {
      this.x = z;
      this.p = this.r;
      return z;
    }
    this.p += this.q;
    const k = this.p / (this.p + this.r);
    this.x += k * (z - this.x);
    this.p *= 1 - k;
    return this.x;
  }
  get value() {
    return this.x;
  }
}

// ─── Security / PHY classification ────────────────────────────────────────

const SECURITY_LABELS: Record<string, string> = {
  open: "Aberta",
  wep: "WEP",
  wpa: "WPA",
  wpa2: "WPA2",
  wpa2e: "WPA2-Enterprise",
  wpa3: "WPA3",
  wpa3t: "WPA2/WPA3",
  wpa3e: "WPA3-Enterprise",
  owe: "OWE",
};

export function securityLabel(tokens: string[]): string {
  if (!tokens.length) return "Desconhecida";
  const order = ["wpa3e", "wpa3t", "wpa3", "wpa2e", "wpa2", "owe", "wpa", "wep", "open"];
  const best = order.find((t) => tokens.includes(t));
  if (best === "wpa2" && tokens.includes("wpa")) return "WPA/WPA2";
  return SECURITY_LABELS[best ?? tokens[0]] ?? tokens.join("/").toUpperCase();
}

export function securityGrade(tokens: string[]): "A" | "B" | "C" | "D" | "F" {
  if (tokens.includes("wpa3e")) return "A";
  if (tokens.includes("wpa3t")) return "B"; // transition mode still accepts WPA2-PSK
  if (tokens.includes("wpa3")) return "A";
  if (tokens.includes("wpa2e")) return "B";
  if (tokens.includes("wpa2")) return tokens.includes("wpa") ? "C" : "B";
  if (tokens.includes("owe")) return "C";
  if (tokens.includes("wpa")) return "D";
  if (!tokens.length) return "C";
  return "F"; // open / WEP
}

const PHY_ORDER = ["be", "ax", "ac", "n", "g", "a", "b"];

export function bestPhy(phy: string[]): string | null {
  return PHY_ORDER.find((p) => phy.includes(p)) ?? null;
}

export function phyLabel(phy: string[]): string {
  const best = bestPhy(phy);
  return best ? `802.11${best}` : "802.11";
}

export function generationLabel(phy: string | null, band: Band | null): string {
  switch (phy) {
    case "be":
      return "Wi-Fi 7";
    case "ax":
      return band === "6" ? "Wi-Fi 6E" : "Wi-Fi 6";
    case "ac":
      return "Wi-Fi 5";
    case "n":
      return "Wi-Fi 4";
    case "g":
    case "a":
      return "Legacy";
    case "b":
      return "Legacy (b)";
    default:
      return "—";
  }
}

/** Theoretical PHY rate assuming 2 spatial streams at the top MCS. */
export function maxPhyRate(phy: string | null, width: number): number | null {
  const table: Record<string, Record<number, number>> = {
    be: { 20: 344, 40: 688, 80: 1441, 160: 2882, 320: 5765 },
    ax: { 20: 287, 40: 574, 80: 1201, 160: 2402 },
    ac: { 20: 173, 40: 400, 80: 867, 160: 1733 },
    n: { 20: 144, 40: 300 },
    g: { 20: 54 },
    a: { 20: 54 },
    b: { 20: 11 },
  };
  if (!phy || !table[phy]) return null;
  const row = table[phy];
  const widths = Object.keys(row).map(Number);
  const w = widths.filter((x) => x <= width).pop() ?? widths[0];
  return row[w];
}

// ─── Identity helpers ─────────────────────────────────────────────────────

export function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const CODEWORDS = [
  "ECHO", "NOVA", "ORBIT", "PULSE", "VECTOR", "CIPHER", "ZION", "ORACLE", "NEBULA", "QUARK",
  "HALO", "RELAY", "SPECTRE", "AXIOM", "FLUX", "PRISM", "DELTA", "KAIROS", "ION", "VERTEX",
  "MORPH", "SIGMA", "TAU", "NEXUS", "ONYX", "RADIX", "LUMEN", "OMEGA", "TESLA", "VOLT",
];

export function codename(seed: string): string {
  const h = fnv1a(seed);
  const word = CODEWORDS[h % CODEWORDS.length];
  const tag = ((h >>> 8) & 0xfff).toString(16).toUpperCase().padStart(3, "0");
  return `${word}-${tag}`;
}

export function isRandomizedMac(mac: string | null): boolean {
  if (!mac) return false;
  const first = parseInt(mac.slice(0, 2), 16);
  return Number.isFinite(first) && (first & 0x02) === 0x02;
}

export function normalizeMac(mac: string | null | undefined): string | null {
  if (!mac) return null;
  const hex = mac.replace(/[^0-9a-fA-F]/g, "");
  if (hex.length !== 12) return null;
  return hex.toUpperCase().match(/.{2}/g)!.join(":");
}

/** Shared visual radius mapping (log scale): meters → 0..1 of the view radius. */
export function radialScale(meters: number, maxMeters = 60): number {
  return Math.min(Math.log1p(meters / 2) / Math.log1p(maxMeters / 2), 1);
}

export function stats(values: number[]) {
  const n = values.length;
  if (!n) return { mean: 0, std: 0, min: 0, max: 0 };
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const mean = sum / n;
  let varSum = 0;
  for (const v of values) varSum += (v - mean) ** 2;
  return { mean, std: n > 1 ? Math.sqrt(varSum / (n - 1)) : 0, min, max };
}
