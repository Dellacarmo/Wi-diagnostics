// Shared helpers for the web frontend (mirrors engine/rf.ts where needed).

export const WORLD_R = 40; // scene units for MAX_M meters
export const MAX_M = 60;
const LOG_MAX = Math.log1p(MAX_M / 2);

/** Meters → scene radius (log scale, same mapping as the terminal radar). */
export const toScene = (m) => (Math.min(Math.log1p(Math.max(m, 0) / 2) / LOG_MAX, 1.15)) * WORLD_R;
/** Scene radius → meters. */
export const fromScene = (s) => 2 * Math.expm1((s / WORLD_R) * LOG_MAX);

export const RING_METERS = [1, 2, 5, 10, 20, 50];

export const BAND_HEX = { "2.4": 0x5bff3a, 5: 0x22e6ff, 6: 0xd17bff };
export const BAND_CSS = { "2.4": "#5bff3a", 5: "#22e6ff", 6: "#d17bff" };
export const LINK_HEX = 0xffd76a;
export const LINK_CSS = "#ffd76a";
export const GRADE_CSS = { A: "#3dff9e", B: "#a8ff5c", C: "#ffc145", D: "#ff8c42", F: "#ff4d6d" };
export const REF_RSSI = { "2.4": -30, 5: -36, 6: -38 };

export function rssiCss(rssi) {
  if (rssi >= -55) return "#3dff9e";
  if (rssi >= -67) return "#b8ff5c";
  if (rssi >= -75) return "#ffc145";
  if (rssi >= -82) return "#ff8c42";
  return "#ff4d6d";
}

export function rssiLabel(rssi) {
  if (rssi >= -55) return "excelente";
  if (rssi >= -67) return "bom";
  if (rssi >= -75) return "razoável";
  if (rssi >= -82) return "fraco";
  return "crítico";
}

export const levelCss = (l) => (l === "good" ? "#3dff9e" : l === "warn" ? "#ffc145" : l === "bad" ? "#ff4d6d" : "#7fd6ff");

export const fmtDist = (m) => (m == null ? "—" : m < 10 ? `${m.toFixed(1)} m` : `${Math.round(m)} m`);
export const fmtMs = (ms) => (ms == null ? "—" : ms < 10 ? ms.toFixed(1) : Math.round(ms).toString());

export function ago(t) {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  return `${Math.floor(s / 3600)} h`;
}

export const clock = (t) => new Date(t).toLocaleTimeString("pt-BR", { hour12: false });

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

export const isDfs = (ch, band) => band === "5" && ch >= 52 && ch <= 144;

/** Canvas sized to its CSS box at device pixel ratio; returns a 2D context in CSS pixels. */
export function fitCanvas(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

export function hexToRgba(hex, a) {
  const n = typeof hex === "number" ? hex : parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Half-width katakana + digits used by every digital-rain effect. */
export const GLYPHS = "ｦｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789:.=*+-<>¦";
