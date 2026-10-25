/**
 * Probable-position estimation from a single stationary receiver.
 *
 * Range comes from RSSI (path-loss model). Bearing is unobservable with one antenna,
 * so it is inferred from weaker cues:
 *  - radios of the same physical AP (adjacent BSSIDs / same SSID) share a bearing;
 *  - radios whose RSSI fluctuates together (Pearson correlation) are pulled together,
 *    since they likely sit behind the same obstacles;
 *  - a deterministic per-device seed keeps the layout stable between runs;
 *  - tangential repulsion keeps nodes readable.
 */

import type { Position } from "./types";
import { fnv1a, radialScale } from "./rf";

export interface LayoutInput {
  id: string;
  group: string | null;
  distance: number;
  samples: number;
  rssiStd: number;
  series: Map<number, number>;
}

const TAU = Math.PI * 2;
const wrap = (a: number) => ((a % TAU) + TAU) % TAU;
const angleDiff = (to: number, from: number) => {
  const d = wrap(to - from);
  return d > Math.PI ? d - TAU : d;
};

function pearson(a: Map<number, number>, b: Map<number, number>): { r: number; n: number } {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [seq, v] of a) {
    const w = b.get(seq);
    if (w !== undefined) {
      xs.push(v);
      ys.push(w);
    }
  }
  const n = xs.length;
  if (n < 8) return { r: 0, n };
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < n; i++) {
    cov += (xs[i] - mx) * (ys[i] - my);
    vx += (xs[i] - mx) ** 2;
    vy += (ys[i] - my) ** 2;
  }
  return { r: vx > 0 && vy > 0 ? cov / Math.sqrt(vx * vy) : 0, n };
}

/**
 * Removes each series' mean and then the per-scan common mode (the average deviation of
 * all networks in that scan). What remains is direction-specific fading; receiver-side
 * effects such as antenna orientation or the user's body move every network together.
 */
function residualSeries(list: Map<number, number>[]): Map<number, number>[] {
  const centered = list.map((s) => {
    let sum = 0;
    for (const v of s.values()) sum += v;
    const mean = s.size ? sum / s.size : 0;
    return new Map([...s].map(([seq, v]) => [seq, v - mean] as [number, number]));
  });
  const common = new Map<number, { sum: number; n: number }>();
  for (const s of centered)
    for (const [seq, v] of s) {
      const c = common.get(seq) ?? { sum: 0, n: 0 };
      c.sum += v;
      c.n++;
      common.set(seq, c);
    }
  return centered.map(
    (s) => new Map([...s].map(([seq, v]) => {
      const c = common.get(seq)!;
      return [seq, c.n > 2 ? v - c.sum / c.n : v] as [number, number];
    })),
  );
}

export class Layout {
  private display = new Map<string, number>();
  private correlationCache = new Map<string, number>();
  private tick = 0;

  compute(items: LayoutInput[]): Map<string, Position> {
    this.tick++;
    const n = items.length;
    const theta = new Float64Array(n);
    const radius = items.map((it) => radialScale(it.distance));

    // 1. Seed bearings per physical device, with a small fan-out inside a group.
    const groupMembers = new Map<string, number>();
    items.forEach((it, i) => {
      const key = it.group ?? it.id;
      const k = groupMembers.get(key) ?? 0;
      groupMembers.set(key, k + 1);
      theta[i] = wrap((fnv1a(key) / 0xffffffff) * TAU + (k ? (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.05 : 0));
    });

    // 2. Correlated fading → shared bearing (recomputed every few ticks; O(n²)).
    if (this.tick % 3 === 1) {
      const residuals = residualSeries(items.map((it) => it.series));
      this.correlationCache.clear();
      for (let i = 0; i < n; i++)
        for (let j = i + 1; j < n; j++) {
          const { r } = pearson(residuals[i], residuals[j]);
          if (r > 0.6) this.correlationCache.set(`${items[i].id}|${items[j].id}`, r);
        }
    }
    // Each node moves part of the way towards the weighted mean bearing of its correlated
    // partners (averaged, so a node with many partners does not get dragged around).
    const seed = Float64Array.from(theta);
    const pullSum = new Float64Array(n);
    const pullCount = new Uint16Array(n);
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) {
        const sameGroup = items[i].group && items[i].group === items[j].group;
        const r = this.correlationCache.get(`${items[i].id}|${items[j].id}`);
        if (!r || sameGroup) continue;
        const w = (r - 0.6) / 0.4;
        pullSum[i] += angleDiff(seed[j], seed[i]) * w;
        pullSum[j] += angleDiff(seed[i], seed[j]) * w;
        pullCount[i]++;
        pullCount[j]++;
      }
    for (let i = 0; i < n; i++) if (pullCount[i]) theta[i] = wrap(theta[i] + (pullSum[i] / pullCount[i]) * 0.35);

    // 3. Tangential repulsion in the (log-scaled) view plane.
    const minSep = 0.085;
    for (let iter = 0; iter < 40; iter++) {
      for (let i = 0; i < n; i++)
        for (let j = i + 1; j < n; j++) {
          if (items[i].group && items[i].group === items[j].group) continue;
          const dx = radius[i] * Math.cos(theta[i]) - radius[j] * Math.cos(theta[j]);
          const dz = radius[i] * Math.sin(theta[i]) - radius[j] * Math.sin(theta[j]);
          const dist = Math.hypot(dx, dz);
          if (dist >= minSep) continue;
          const push = ((minSep - dist) / minSep) * 0.06;
          const dir = angleDiff(theta[i], theta[j]) >= 0 ? 1 : -1;
          theta[i] = wrap(theta[i] + push * dir);
          theta[j] = wrap(theta[j] - push * dir);
        }
    }

    // 4. Smooth towards the new targets so the scene glides instead of jumping.
    const out = new Map<string, Position>();
    const alive = new Set<string>();
    items.forEach((it, i) => {
      alive.add(it.id);
      const prev = this.display.get(it.id);
      const az = prev === undefined ? theta[i] : wrap(prev + angleDiff(theta[i], prev) * 0.3);
      this.display.set(it.id, az);
      const h = fnv1a(`${it.group ?? it.id}:h`) / 0xffffffff;
      const confidence = Math.min(it.samples / 12, 1) * (1 - Math.min(it.rssiStd / 10, 0.6));
      out.set(it.id, {
        x: it.distance * Math.cos(az),
        y: -0.4 + h * 2.0,
        z: it.distance * Math.sin(az),
        azimuth: az,
        confidence: Math.round(confidence * 100) / 100,
      });
    });
    for (const id of this.display.keys()) if (!alive.has(id)) this.display.delete(id);
    return out;
  }
}

/** Groups radios of the same physical AP: adjacent BSSIDs, or identical SSIDs. */
export function deviceGroup(bssid: string | null, ssid: string | null): string | null {
  if (bssid) {
    const o = bssid.split(":");
    return `mac:${o.slice(1, 5).join("")}${o[5][0]}`;
  }
  if (ssid) return `ssid:${ssid.replace(/[-_ ]?(2\.?4G?|5G|6E?|5GHz|2GHz)$/i, "")}`;
  return null;
}
