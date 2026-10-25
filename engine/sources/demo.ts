/**
 * Demo source: a synthetic neighbourhood with physically plausible RSSI
 * (log-distance path loss + per-network wall loss + fading + noise).
 */

import type { Band, RawLink, SourceStatus } from "../types";
import { fnv1a } from "../rf";
import { emptyLink, type Observation, type ScanSource, type SourceHandlers } from "./source";

interface DemoAp {
  ssid: string | null;
  vendor: string;
  oui: string;
  band: Band;
  channel: number;
  width: number;
  security: string[];
  phy: string[];
  x: number; // meters
  z: number;
  wallLoss: number;
  txOffset: number;
  transient?: [number, number]; // visible window inside a 120 s cycle
}

const AP_LIST: DemoAp[] = [
  { ssid: "Casa_Silva", vendor: "TP-Link", oui: "50:C7:BF", band: "5", channel: 36, width: 80, security: ["wpa2", "wpa3t"], phy: ["a", "n", "ac", "ax"], x: 3.2, z: -1.8, wallLoss: 0, txOffset: 2 },
  { ssid: "Casa_Silva", vendor: "TP-Link", oui: "50:C7:BF", band: "2.4", channel: 6, width: 20, security: ["wpa2", "wpa3t"], phy: ["b", "g", "n", "ax"], x: 3.2, z: -1.8, wallLoss: 0, txOffset: 0 },
  { ssid: "Casa_Silva_6E", vendor: "TP-Link", oui: "50:C7:BF", band: "6", channel: 37, width: 160, security: ["wpa3"], phy: ["ax"], x: 3.2, z: -1.8, wallLoss: 0, txOffset: -1 },
  { ssid: "VIVOFIBRA-8A2C", vendor: "Mitrastar", oui: "D8:C6:78", band: "5", channel: 44, width: 80, security: ["wpa2"], phy: ["a", "n", "ac"], x: -9, z: 6, wallLoss: 9, txOffset: 0 },
  { ssid: "VIVOFIBRA-8A2C", vendor: "Mitrastar", oui: "D8:C6:78", band: "2.4", channel: 1, width: 20, security: ["wpa2"], phy: ["b", "g", "n"], x: -9, z: 6, wallLoss: 9, txOffset: 0 },
  { ssid: "NET_2G4F1D90", vendor: "Askey", oui: "E0:B7:0A", band: "2.4", channel: 11, width: 40, security: ["wpa", "wpa2"], phy: ["b", "g", "n"], x: 14, z: 9, wallLoss: 14, txOffset: 0 },
  { ssid: "NET_5G4F1D90", vendor: "Askey", oui: "E0:B7:0A", band: "5", channel: 149, width: 80, security: ["wpa2"], phy: ["a", "n", "ac"], x: 14, z: 9, wallLoss: 14, txOffset: 0 },
  { ssid: "CLARO_WIFI", vendor: "Huawei", oui: "48:46:FB", band: "2.4", channel: 6, width: 20, security: ["open"], phy: ["b", "g", "n"], x: -22, z: -14, wallLoss: 10, txOffset: 3 },
  { ssid: "Escritorio_Mesh", vendor: "Ubiquiti", oui: "74:83:C2", band: "5", channel: 100, width: 160, security: ["wpa2e"], phy: ["a", "n", "ac", "ax"], x: 7, z: 18, wallLoss: 11, txOffset: 1 },
  { ssid: "Ap_302", vendor: "Intelbras", oui: "00:1A:3F", band: "2.4", channel: 3, width: 20, security: ["wpa2"], phy: ["b", "g", "n"], x: -4, z: -11, wallLoss: 12, txOffset: -2 },
  { ssid: "Ap_302_5G", vendor: "Intelbras", oui: "00:1A:3F", band: "5", channel: 52, width: 80, security: ["wpa2"], phy: ["a", "n", "ac"], x: -4, z: -11, wallLoss: 12, txOffset: -2 },
  { ssid: "HP-Print-3F-LaserJet", vendor: "HP", oui: "A0:D3:C1", band: "2.4", channel: 6, width: 20, security: ["wpa2"], phy: ["b", "g", "n"], x: 5, z: 4, wallLoss: 4, txOffset: -8 },
  { ssid: null, vendor: "ZTE", oui: "34:DE:34", band: "5", channel: 157, width: 80, security: ["wpa2"], phy: ["a", "n", "ac"], x: 19, z: -16, wallLoss: 15, txOffset: 0 },
  { ssid: "Starlink", vendor: "SpaceX", oui: "74:24:9F", band: "5", channel: 116, width: 80, security: ["wpa2"], phy: ["a", "n", "ac", "ax"], x: -28, z: 10, wallLoss: 8, txOffset: 2 },
  { ssid: "Familia Rocha 2.4", vendor: "Nokia", oui: "F8:D1:11", band: "2.4", channel: 11, width: 20, security: ["wpa2"], phy: ["b", "g", "n", "ax"], x: 11, z: -20, wallLoss: 13, txOffset: 0 },
  { ssid: "Cafe_Wifi_Gratis", vendor: "Ubiquiti", oui: "74:83:C2", band: "2.4", channel: 1, width: 20, security: ["wep"], phy: ["b", "g"], x: -34, z: -22, wallLoss: 9, txOffset: 1 },
  { ssid: "iPhone de Ana", vendor: "Apple", oui: "8E:1F:64", band: "5", channel: 149, width: 80, security: ["wpa2", "wpa3t"], phy: ["a", "n", "ac", "ax"], x: 2, z: 6, wallLoss: 3, txOffset: -6, transient: [20, 85] },
  { ssid: "Galaxy A54", vendor: "Samsung", oui: "AA:4C:01", band: "2.4", channel: 9, width: 20, security: ["wpa2"], phy: ["b", "g", "n", "ax"], x: -6, z: 2, wallLoss: 6, txOffset: -7, transient: [60, 115] },
];

const REF: Record<Band, number> = { "2.4": -30, "5": -36, "6": -38 };

function gauss() {
  return Math.sqrt(-2 * Math.log(Math.random() || 1e-9)) * Math.cos(2 * Math.PI * Math.random());
}

function demoBssid(ap: DemoAp, index: number): string {
  const h = fnv1a(`${ap.oui}-${ap.x}-${ap.z}`); // radios of one physical AP share a prefix
  const b = [(h >>> 16) & 0xff, (h >>> 8) & 0xff, (h & 0xf0) | (index % 3)];
  return `${ap.oui}:${b.map((v) => v.toString(16).padStart(2, "0").toUpperCase()).join(":")}`;
}

export class DemoSource implements ScanSource {
  status: SourceStatus = { kind: "demo", label: "Demo · ambiente sintético", redacted: false, note: null };
  private timers: ReturnType<typeof setInterval>[] = [];
  private t0 = Date.now();
  private bssids = AP_LIST.map((ap, i) => demoBssid(ap, AP_LIST.filter((a, j) => j < i && a.oui === ap.oui && a.x === ap.x).length));

  constructor(private intervalSec = 2) {}

  private rssiFor(ap: DemoAp, t: number): number {
    const d = Math.hypot(ap.x, ap.z, 1.2);
    const fading = 2.2 * Math.sin(t / 7 + ap.x) + 1.4 * Math.sin(t / 2.3 + ap.z);
    const n = 3.0;
    return Math.round(REF[ap.band] + ap.txOffset - 10 * n * Math.log10(d) - ap.wallLoss + fading + gauss() * 1.8);
  }

  async start(h: SourceHandlers) {
    h.onStatus(this.status);
    const scan = () => {
      const t = (Date.now() - this.t0) / 1000;
      const cycle = t % 120;
      const networks: Observation[] = [];
      AP_LIST.forEach((ap, i) => {
        if (ap.transient && (cycle < ap.transient[0] || cycle > ap.transient[1])) return;
        const rssi = this.rssiFor(ap, t);
        if (rssi < -94) return;
        networks.push({
          ssid: ap.ssid,
          bssid: this.bssids[i],
          rssi,
          noise: -95 + Math.round(gauss()),
          channel: ap.channel,
          band: ap.band,
          width: ap.width,
          security: ap.security,
          phy: ap.phy,
          beaconInterval: 100,
          vendorHint: ap.vendor,
        });
      });
      h.onScan({ networks, durationMs: 1800 + Math.round(Math.random() * 600) });
    };
    const link = () => {
      const t = (Date.now() - this.t0) / 1000;
      const ap = AP_LIST[0];
      const rssi = this.rssiFor(ap, t);
      const snr = rssi + 95;
      const mcs = Math.max(0, Math.min(11, Math.round((snr - 8) / 3.4)));
      const rates = [72, 144, 216, 288, 432, 576, 649, 721, 865, 961, 1081, 1201];
      const l: RawLink = {
        ...emptyLink(),
        iface: "wlan0",
        ssid: ap.ssid,
        bssid: this.bssids[0],
        rssi,
        noise: -95,
        txRate: rates[mcs],
        mcs,
        channel: ap.channel,
        band: ap.band,
        width: ap.width,
        phy: "ax",
        security: "wpa3t",
        mac: "3C:22:FB:9A:10:7E",
        country: "BR",
      };
      h.onLink(l);
    };
    scan();
    link();
    this.timers.push(setInterval(scan, this.intervalSec * 1000), setInterval(link, 1000));
  }

  stop() {
    this.timers.forEach(clearInterval);
  }
}
