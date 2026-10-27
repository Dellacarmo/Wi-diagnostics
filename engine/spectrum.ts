/**
 * Spectrum analysis: per-channel airtime pressure, interference per network,
 * and best-channel recommendations.
 */

import type { Band, BandSpectrum, ChannelStat, Interference } from "./types";
import { BAND_CHANNELS, BAND_RANGES, channelFrequency, channelSpan, dbmToMw, isDfs, mwToDbm } from "./rf";

export interface SpectrumInput {
  id: string;
  band: Band;
  channel: number;
  span: [number, number];
  rssi: number;
  group: string | null;
}

const overlap = (a: [number, number], b: [number, number]) => Math.max(0, Math.min(a[1], b[1]) - Math.max(a[0], b[0]));

/** Strong neighbours matter more: -45 dBm ≈ 1.0, -95 dBm ≈ 0. */
const weight = (rssi: number) => Math.min(Math.max((rssi + 95) / 50, 0), 1);

export function analyzeSpectrum(nets: SpectrumInput[]): BandSpectrum[] {
  const bands: Band[] = ["2.4", "5", "6"];
  return bands.map((band) => {
    const inBand = nets.filter((n) => n.band === band);
    const channels: ChannelStat[] = BAND_CHANNELS[band].map((ch) => {
      const span = channelSpan(ch, band, 20);
      let pressure = 0;
      let count = 0;
      for (const n of inBand) {
        const o = overlap(span, n.span) / (span[1] - span[0]);
        if (o <= 0) continue;
        count++;
        pressure += weight(n.rssi) * o;
      }
      return { channel: ch, freq: channelFrequency(ch, band), load: 1 - Math.exp(-pressure / 1.2), count };
    });

    let best: BandSpectrum["best"] = null;
    if (band === "2.4") {
      const candidates = channels.filter((c) => [1, 6, 11].includes(c.channel));
      const c = candidates.sort((a, b) => a.load - b.load)[0];
      best = { channel: c.channel, width: 20, load: c.load, span: channelSpan(c.channel, band, 20) };
    } else if (band === "5") {
      const starts = [36, 52, 100, 116, 132, 149];
      let bestScore = Infinity;
      for (const s of starts) {
        const block = channels.filter((c) => c.channel >= s && c.channel < s + 16);
        if (!block.length) continue;
        const load = block.reduce((a, c) => a + c.load, 0) / block.length;
        const score = load + (isDfs(s, band) ? 0.06 : 0); // DFS can force channel changes
        if (score < bestScore) {
          bestScore = score;
          best = { channel: s, width: 80, load, span: channelSpan(s, band, 80) };
        }
      }
    } else if (inBand.length) {
      const psc = channels.filter((c) => (c.channel - 5) % 16 === 0); // preferred scanning channels
      // Rank each PSC by the mean load of its whole 160 MHz block; strict `<` keeps one PSC per block.
      for (const c of psc) {
        const span = channelSpan(c.channel, band, 160);
        if (span[1] > BAND_RANGES[band][1]) continue; // channels 225-233 don't form a 160 MHz block
        const sub = channels.filter((x) => {
          const s = channelSpan(x.channel, band, 20);
          return s[0] >= span[0] && s[1] <= span[1];
        });
        const load = sub.reduce((a, x) => a + x.load, 0) / sub.length;
        if (!best || load < best.load) best = { channel: c.channel, width: 160, load, span };
      }
    }

    return { band, range: BAND_RANGES[band], channels, best };
  });
}

export function interferenceFor(target: SpectrumInput, nets: SpectrumInput[]): Interference {
  const width = target.span[1] - target.span[0];
  let total = 0;
  let cochannel = 0;
  let overlapping = 0;
  const contributions: { id: string; mw: number }[] = [];

  for (const n of nets) {
    if (n.id === target.id || n.band !== target.band) continue;
    if (target.group && n.group === target.group) continue; // same AP: shared airtime, not interference
    const f = overlap(target.span, n.span) / width;
    if (f <= 0) continue;
    if (n.channel === target.channel || f >= 0.5) cochannel++;
    else overlapping++;
    const mw = dbmToMw(n.rssi) * f;
    total += mw;
    contributions.push({ id: n.id, mw });
  }

  const sir = total > 0 ? target.rssi - mwToDbm(total) : null;
  const score = sir === null ? 0 : Math.round(Math.min(Math.max((25 - sir) * 3, 0), 100));
  return {
    score,
    cochannel,
    overlapping,
    sir: sir === null ? null : Math.round(sir * 10) / 10,
    neighbors: contributions.sort((a, b) => b.mw - a.mw).slice(0, 5).map((c) => c.id),
  };
}
