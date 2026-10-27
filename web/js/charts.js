// Dock charts: spectrum analyzer, latency timeline and the inspector sparkline.

import { BAND_CSS, LINK_CSS, fitCanvas, hexToRgba, rssiCss } from "./util.js";

const TICKS = {
  "2.4": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
  5: [36, 44, 52, 60, 100, 108, 116, 124, 132, 140, 149, 157, 165],
  6: [1, 33, 65, 97, 129, 161, 193, 225],
};
const DB_LO = -100;
const DB_HI = -25;

export class SpectrumChart {
  constructor(canvas) {
    this.canvas = canvas;
    this.band = "2.4";
    this.hits = [];
    this.hoverId = null;
    this.selectedId = null;
  }

  /** Returns the network id under a CSS-pixel point, if any. */
  hitTest(x, y) {
    let best = null;
    for (const h of this.hits) {
      if (x < h.x0 || x > h.x1) continue;
      const u = (x - (h.x0 + h.x1) / 2) / ((h.x1 - h.x0) / 2);
      const yTop = h.base - (h.base - h.top) * h.shape(u);
      if (y >= yTop - 6 && y <= h.base && (!best || h.top < best.top)) best = h;
    }
    return best?.id ?? null;
  }

  draw(snap) {
    const { ctx, w, h } = fitCanvas(this.canvas);
    ctx.clearRect(0, 0, w, h);
    if (!snap || w < 50) return;
    const spec = snap.spectrum.find((b) => b.band === this.band);
    const padL = 40;
    const padB = 20;
    const padT = 8;
    const pw = w - padL - 10;
    const ph = h - padB - padT;
    const [lo, hi] = spec.range;
    const fx = (f) => padL + ((f - lo) / (hi - lo)) * pw;
    const fy = (db) => padT + (1 - Math.min(Math.max((db - DB_LO) / (DB_HI - DB_LO), 0), 1)) * ph;
    const base = fy(DB_LO);

    // Grid
    ctx.font = "10px 'JetBrains Mono', monospace";
    ctx.textBaseline = "middle";
    for (const db of [-30, -50, -70, -90]) {
      ctx.strokeStyle = "rgba(70,255,143,0.07)";
      ctx.setLineDash([2, 4]);
      ctx.beginPath();
      ctx.moveTo(padL, fy(db));
      ctx.lineTo(padL + pw, fy(db));
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(111,156,128,0.7)";
      ctx.textAlign = "right";
      ctx.fillText(String(db), padL - 8, fy(db));
    }

    // Channel load heat strip + ticks
    for (const c of spec.channels) {
      const x = fx(c.freq);
      if (c.load > 0.02) {
        ctx.fillStyle = `rgba(255, ${Math.round(200 - c.load * 140)}, 80, ${0.08 + c.load * 0.3})`;
        ctx.fillRect(x - 3, base + 2, 6, 3);
      }
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (const ch of TICKS[this.band]) {
      const c = spec.channels.find((k) => k.channel === ch);
      if (!c) continue;
      const isBest = spec.best?.channel === ch;
      ctx.fillStyle = isBest ? "#3dff9e" : "rgba(111,156,128,0.85)";
      ctx.fillText(String(ch), fx(c.freq), base + 7);
    }

    // Best channel marker
    if (spec.best) {
      const [b0, b1] = spec.best.span;
      const grad = ctx.createLinearGradient(0, padT, 0, base);
      grad.addColorStop(0, "rgba(61,255,158,0)");
      grad.addColorStop(1, "rgba(61,255,158,0.16)");
      ctx.fillStyle = grad;
      ctx.fillRect(fx(b0), padT, fx(b1) - fx(b0), base - padT);
      ctx.strokeStyle = "rgba(61,255,158,0.35)";
      ctx.setLineDash([3, 3]);
      ctx.strokeRect(fx(b0) + 0.5, padT + 0.5, fx(b1) - fx(b0) - 1, base - padT);
      ctx.setLineDash([]);
    }

    // Networks (weak first so strong ones sit on top)
    this.hits = [];
    const nets = snap.networks.filter((n) => n.band === this.band).sort((a, b) => a.rssi - b.rssi);
    const shape24 = (u) => 0.5 * (1 + Math.cos(Math.PI * Math.min(Math.abs(u), 1)));
    const shapeOfdm = (u) => Math.min(1, (1 - Math.min(Math.abs(u), 1)) / 0.1);
    const shape = this.band === "2.4" ? shape24 : shapeOfdm;
    for (const n of nets) {
      const x0 = fx(n.span[0]);
      const x1 = fx(n.span[1]);
      const top = fy(n.rssi);
      const isSel = n.id === this.selectedId;
      const isHover = n.id === this.hoverId;
      const color = n.connected ? LINK_CSS : BAND_CSS[this.band];
      const strength = n.stale ? 0.25 : 0.45 + 0.55 * Math.min(Math.max((n.rssi + 95) / 65, 0), 1);

      ctx.beginPath();
      ctx.moveTo(x0, base);
      const steps = Math.max(Math.ceil((x1 - x0) / 2), 8);
      for (let i = 0; i <= steps; i++) {
        const u = (i / steps) * 2 - 1;
        ctx.lineTo(x0 + ((x1 - x0) * i) / steps, base - (base - top) * shape(u));
      }
      ctx.lineTo(x1, base);
      const fill = ctx.createLinearGradient(0, top, 0, base);
      fill.addColorStop(0, hexToRgba(color, (isSel || isHover ? 0.32 : 0.13) * strength));
      fill.addColorStop(1, hexToRgba(color, 0.02));
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.lineWidth = isSel ? 2.2 : isHover ? 1.8 : 1.2;
      ctx.strokeStyle = isSel ? "#f0fff4" : hexToRgba(color, strength);
      ctx.shadowColor = color;
      ctx.shadowBlur = isSel || n.connected ? 12 : 0;
      ctx.stroke();
      ctx.shadowBlur = 0;
      this.hits.push({ id: n.id, x0, x1, top, base, shape });
    }

    // Labels for the strongest few + selection
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    const labelled = new Set([this.selectedId, this.hoverId, ...nets.filter((n) => n.connected).map((n) => n.id), ...[...nets].reverse().slice(0, 4).map((n) => n.id)]);
    const placed = [];
    for (const n of [...nets].reverse()) {
      if (!labelled.has(n.id)) continue;
      const x = (fx(n.span[0]) + fx(n.span[1])) / 2;
      const y = fy(n.rssi) - 4;
      const text = n.name.length > 16 ? n.name.slice(0, 15) + "…" : n.name;
      const tw = ctx.measureText(text).width;
      if (placed.some((p) => Math.abs(p.x - x) < (p.w + tw) / 2 + 4 && Math.abs(p.y - y) < 12)) continue;
      placed.push({ x, y, w: tw });
      ctx.fillStyle = n.id === this.selectedId ? "#f0fff4" : n.connected ? LINK_CSS : "rgba(203,247,218,0.85)";
      ctx.fillText(text, x, y);
    }
  }
}

export class LatencyChart {
  constructor(canvas) {
    this.canvas = canvas;
  }

  draw(snap) {
    const { ctx, w, h } = fitCanvas(this.canvas);
    ctx.clearRect(0, 0, w, h);
    if (!snap || w < 50) return;
    const l = snap.link;
    const series = [
      { name: `gateway ${l.gatewayPing.target ?? ""}`, data: l.gatewayPing.history, color: "#3dff9e" },
      { name: `internet ${l.internetPing.target ?? ""}`, data: l.internetPing.history, color: "#22e6ff" },
    ];
    const padL = 40;
    const padB = 18;
    const padT = 10;
    const pw = w - padL - 170;
    const ph = h - padB - padT;
    const all = series.flatMap((s) => s.data.filter((v) => v !== null));
    const max = Math.max(20, ...all) * 1.15;
    const fy = (v) => padT + (1 - v / max) * ph;

    ctx.font = "10px 'JetBrains Mono', monospace";
    ctx.textBaseline = "middle";
    ctx.textAlign = "right";
    for (const v of [0, max / 2, max]) {
      ctx.strokeStyle = "rgba(70,255,143,0.07)";
      ctx.setLineDash([2, 4]);
      ctx.beginPath();
      ctx.moveTo(padL, fy(v));
      ctx.lineTo(padL + pw, fy(v));
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(111,156,128,0.7)";
      ctx.fillText(`${Math.round(v)}ms`, padL - 6, fy(v));
    }

    for (const s of series) {
      const n = s.data.length;
      const fx = (i) => padL + pw - ((n - 1 - i) * pw) / 59; // newest sample on the right edge
      ctx.beginPath();
      let pen = false;
      s.data.forEach((v, i) => {
        if (v === null) {
          pen = false;
          ctx.fillStyle = "#ff4d6d";
          ctx.fillRect(fx(i) - 1, padT, 2, ph);
          return;
        }
        if (pen) ctx.lineTo(fx(i), fy(v));
        else ctx.moveTo(fx(i), fy(v));
        pen = true;
      });
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 1.6;
      ctx.shadowColor = s.color;
      ctx.shadowBlur = 8;
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    // Legend / stats
    ctx.textAlign = "left";
    let y = padT + 8;
    for (const [s, p] of [[series[0], l.gatewayPing], [series[1], l.internetPing]]) {
      ctx.fillStyle = s.color;
      ctx.fillRect(w - 160, y - 4, 8, 8);
      ctx.fillStyle = "#cbf7da";
      ctx.fillText(s.name, w - 146, y);
      ctx.fillStyle = "rgba(111,156,128,0.9)";
      const fmt = (v) => (v == null ? "—" : `${v.toFixed(1)}ms`);
      ctx.fillText(`méd ${fmt(p.avg)}  jit ${fmt(p.jitter)}`, w - 146, y + 15);
      ctx.fillText(`mín ${fmt(p.min)}  perda ${(p.loss * 100).toFixed(0)}%`, w - 146, y + 29);
      y += 52;
    }
  }
}

export function drawSparkline(canvas, values, color) {
  const { ctx, w, h } = fitCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  if (!values?.length) return;
  const lo = Math.min(...values) - 4;
  const hi = Math.max(...values) + 4;
  const fx = (i) => 8 + (i / Math.max(values.length - 1, 1)) * (w - 16);
  const fy = (v) => 8 + (1 - (v - lo) / (hi - lo)) * (h - 16);
  ctx.beginPath();
  values.forEach((v, i) => (i ? ctx.lineTo(fx(i), fy(v)) : ctx.moveTo(fx(i), fy(v))));
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, hexToRgba(color, 0.3));
  grad.addColorStop(1, hexToRgba(color, 0));
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.6;
  ctx.shadowColor = color;
  ctx.shadowBlur = 8;
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.lineTo(fx(values.length - 1), h);
  ctx.lineTo(fx(0), h);
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.font = "10px 'JetBrains Mono', monospace";
  ctx.fillStyle = "rgba(111,156,128,0.9)";
  ctx.textAlign = "right";
  ctx.fillText(`${Math.round(hi - 4)} dBm`, w - 8, 14);
  ctx.fillText(`${Math.round(lo + 4)} dBm`, w - 8, h - 6);
  const last = values[values.length - 1];
  ctx.fillStyle = rssiCss(last);
  ctx.beginPath();
  ctx.arc(fx(values.length - 1), fy(last), 3, 0, Math.PI * 2);
  ctx.fill();
}
