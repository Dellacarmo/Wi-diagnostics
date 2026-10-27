/**
 * Keeps a stable identity for each radio across scans.
 * With BSSIDs this is trivial; when the OS redacts them (macOS) networks are
 * matched by a radio fingerprint (band/channel/width/security/PHY/beacon) and RSSI proximity.
 */

import type { Band } from "./types";
import { fnv1a, Kalman, normalizeMac } from "./rf";
import type { Observation } from "./sources/source";

export const HISTORY = 90;

export interface Track {
  id: string;
  fingerprint: string;
  ssid: string | null;
  bssid: string | null;
  vendorHint: string | null;
  band: Band;
  channel: number;
  width: number;
  security: string[];
  phy: string[];
  beaconInterval: number | null;
  noise: number | null;
  kalman: Kalman;
  rssi: number;
  rssiRaw: number;
  peak: number;
  history: number[]; // filtered RSSI per scan in which it was seen
  series: Map<number, number>; // scan seq → raw RSSI (for correlation)
  firstSeen: number;
  lastSeen: number;
  lastSeq: number;
  samples: number;
  provisional: boolean;
}

function fingerprintOf(o: Observation): string {
  return [o.band, o.channel, o.width, [...o.security].sort().join("+"), [...o.phy].sort().join("+"), o.beaconInterval ?? "", o.ssid ?? ""].join("|");
}

export class Tracker {
  tracks = new Map<string, Track>();

  /** Returns ids that appeared for the first time in this batch. */
  ingest(observations: Observation[], seq: number, provisional: boolean, now = Date.now()): string[] {
    const fresh: string[] = [];
    const matched = new Set<string>();

    // Strongest first so ambiguous fingerprints pair with the closest track.
    const sorted = [...observations].sort((a, b) => b.rssi - a.rssi);
    for (const o of sorted) {
      const bssid = normalizeMac(o.bssid);
      const fp = fingerprintOf(o);
      let track: Track | undefined;

      if (bssid) {
        track = this.tracks.get(bssid);
      } else {
        let best: Track | undefined;
        let bestDiff = Infinity;
        for (const t of this.tracks.values()) {
          if (t.bssid || matched.has(t.id) || t.fingerprint !== fp) continue;
          const diff = Math.abs(t.rssi - o.rssi);
          if (diff < bestDiff) {
            bestDiff = diff;
            best = t;
          }
        }
        if (best && bestDiff < 22) track = best;
      }

      if (!track) {
        let id = bssid;
        if (!id) {
          // Smallest suffix free among live tracks, so a returning radio gets its old id/codename back.
          const base = `fp-${fnv1a(fp).toString(16)}`;
          let n = 0;
          while (this.tracks.has(n ? `${base}-${n}` : base)) n++;
          id = n ? `${base}-${n}` : base;
        }
        track = {
          id,
          fingerprint: fp,
          ssid: o.ssid,
          bssid,
          vendorHint: o.vendorHint ?? null,
          band: o.band,
          channel: o.channel,
          width: o.width,
          security: o.security,
          phy: o.phy,
          beaconInterval: o.beaconInterval,
          noise: o.noise,
          kalman: new Kalman(),
          rssi: o.rssi,
          rssiRaw: o.rssi,
          peak: o.rssi,
          history: [],
          series: new Map(),
          firstSeen: now,
          lastSeen: now,
          lastSeq: seq,
          samples: 0,
          provisional,
        };
        this.tracks.set(id, track);
        if (!provisional) fresh.push(id);
      } else if (track.provisional && !provisional) {
        track.provisional = false;
      }

      matched.add(track.id);
      track.ssid = o.ssid ?? track.ssid;
      track.channel = o.channel;
      track.width = o.width;
      track.security = o.security.length ? o.security : track.security;
      track.phy = o.phy.length ? o.phy : track.phy;
      track.noise = o.noise ?? track.noise;
      track.rssiRaw = o.rssi;
      track.rssi = track.kalman.update(o.rssi);
      track.peak = Math.max(track.peak, o.rssi);
      track.history.push(track.rssi);
      if (track.history.length > HISTORY) track.history.shift();
      track.series.set(seq, o.rssi);
      if (track.series.size > 40) track.series.delete(track.series.keys().next().value!);
      track.lastSeen = now;
      track.lastSeq = seq;
      track.samples++;
    }

    // A real scan drops cached (provisional) entries it did not confirm.
    if (!provisional) {
      for (const [id, t] of this.tracks) if (t.provisional) this.tracks.delete(id);
    }
    return fresh;
  }

  /** Drops tracks unseen for longer than `expiryMs`; returns their ids. */
  expire(expiryMs: number, now = Date.now()): Track[] {
    const gone: Track[] = [];
    for (const [id, t] of this.tracks) {
      if (now - t.lastSeen > expiryMs) {
        this.tracks.delete(id);
        gone.push(t);
      }
    }
    return gone;
  }
}
