/**
 * Phosphor-green palette and small formatting helpers for the terminal UI.
 */

import type { Band } from "../../engine/types";
import { glyphs, mix, textWidth } from "./screen";

export const C = {
  bg: 0x020604,
  panel: 0x041009,
  select: 0x0a2a17,
  border: 0x124a2b,
  borderHi: 0x1f8a4c,
  title: 0x46ff8f,
  text: 0xb6f2c8,
  bright: 0xe4ffec,
  dim: 0x5b8a6c,
  faint: 0x24402f,
  ghost: 0x0b1f13,
  matrix: 0x00ff66,
  good: 0x3dff9e,
  warn: 0xffc145,
  bad: 0xff4d6d,
  info: 0x7fd6ff,
  link: 0xffe08a,
  receiver: 0xf2fff6,
};

export const BAND_COLOR: Record<Band, number> = {
  "2.4": 0x5bff3a,
  "5": 0x22e6ff,
  "6": 0xd17bff,
};

export const GRADE_COLOR: Record<string, number> = {
  A: 0x3dff9e,
  B: 0xa8ff5c,
  C: 0xffc145,
  D: 0xff8c42,
  F: 0xff4d6d,
};

export function rssiColor(rssi: number): number {
  if (rssi >= -55) return 0x3dff9e;
  if (rssi >= -67) return mix(0xd8ff5c, 0x3dff9e, (rssi + 67) / 12);
  if (rssi >= -75) return mix(0xffc145, 0xd8ff5c, (rssi + 75) / 8);
  if (rssi >= -82) return mix(0xff7a45, 0xffc145, (rssi + 82) / 7);
  return 0xff4d6d;
}

export function levelColor(level: string): number {
  return level === "good" ? C.good : level === "warn" ? C.warn : level === "bad" ? C.bad : C.info;
}

export const SPARK = "▁▂▃▄▅▆▇█";

export function sparkline(values: (number | null)[], width: number, lo: number, hi: number): string {
  const tail = values.slice(-width);
  let s = "";
  for (const v of tail) {
    if (v === null) {
      s += "×";
      continue;
    }
    const t = Math.min(Math.max((v - lo) / (hi - lo || 1), 0), 1);
    s += SPARK[Math.round(t * (SPARK.length - 1))];
  }
  return s.padStart(width, " ");
}

export function bar(value: number, width: number): { full: string; empty: string } {
  const t = Math.min(Math.max(value, 0), 1) * width;
  const whole = Math.floor(t);
  const parts = "▏▎▍▌▋▊▉";
  const frac = t - whole;
  let full = "█".repeat(whole);
  if (whole < width && frac > 0.12) full += parts[Math.min(Math.floor(frac * 7), 6)];
  return { full, empty: "─".repeat(Math.max(width - [...full].length, 0)) };
}

export function fmtDist(m: number): string {
  return m < 10 ? `${m.toFixed(1)}m` : `${Math.round(m)}m`;
}

export function fmtMs(ms: number | null): string {
  if (ms === null) return "—";
  return ms < 10 ? `${ms.toFixed(1)}ms` : `${Math.round(ms)}ms`;
}

export function ago(t: number): string {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}min`;
  return `${Math.floor(s / 3600)}h`;
}

export function clock(t = Date.now()): string {
  return new Date(t).toLocaleTimeString("pt-BR", { hour12: false });
}

/** Fits `s` into `n` terminal cells (wide glyphs count 2); the result is control-free. */
export function truncate(s: string, n: number): string {
  const gs = glyphs(s);
  let width = 0;
  for (const [, w] of gs) width += w;
  let out = "";
  let used = 0;
  const room = width <= n ? n : Math.max(n - 1, 0);
  for (const [c, w] of gs) {
    if (used + w > room) break;
    out += c;
    used += w;
  }
  return width <= n ? out : out + "…";
}

export function pad(s: string, n: number): string {
  const t = truncate(s, n);
  return t + " ".repeat(Math.max(n - textWidth(t), 0));
}

export function padL(s: string, n: number): string {
  const t = truncate(s, n);
  return " ".repeat(Math.max(n - textWidth(t), 0)) + t;
}

/** Half-width katakana + digits: single-cell glyphs for the digital rain. */
export const GLYPHS = "ｦｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789Z:.=*+<>";
export const glyph = () => GLYPHS[(Math.random() * GLYPHS.length) | 0];
