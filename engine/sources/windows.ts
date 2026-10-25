/**
 * Windows source: `netsh wlan` (English and Portuguese output).
 */

import type { Band, RawLink, SourceStatus } from "../types";
import { normalizeMac } from "../rf";
import {
  emptyLink, percentToDbm, runBytes, securityFromText,
  type Observation, type ScanSource, type SourceHandlers,
} from "./source";

const ascii = (s: string) => s.normalize("NFKD").replace(/[^\x20-\x7e]/g, "").trim().toLowerCase();

const CP850_HIGH =
  "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø×ƒáíóúñÑªº¿®¬½¼¡«»░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐└┴┬├─┼ãÃ╚╔╩╦╠═╬¤" +
  "ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀ÓßÔÒõÕµþÞÚÛÙýÝ¯´­±‗¾¶§÷¸°¨·¹³²■ ";

/** Redirected netsh output uses the console OEM code page (CP850 on pt-BR), not UTF-8. */
async function netsh(args: string[], timeoutMs: number): Promise<string> {
  const bytes = await runBytes(["netsh", ...args], timeoutMs);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    let out = "";
    for (const b of bytes) out += b < 0x80 ? String.fromCharCode(b) : CP850_HIGH[b - 0x80];
    return out;
  }
}

function phyFromRadio(radio: string): string[] {
  const r = radio.toLowerCase();
  const out: string[] = [];
  for (const p of ["be", "ax", "ac", "n", "g", "a", "b"]) if (new RegExp(`802\\.11${p}(?![a-z])`).test(r)) out.push(p);
  return out;
}

function bandFrom(value: string, channel: number): Band {
  if (value.includes("6")) return "6";
  if (value.includes("5")) return "5";
  if (value.includes("2.4") || value.includes("2,4")) return "2.4";
  return channel > 14 ? "5" : "2.4";
}

export class WindowsSource implements ScanSource {
  status: SourceStatus = { kind: "windows", label: "Windows · netsh", redacted: false, note: null };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private linkTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(private intervalSec = 3, private iface: string | null = null) {}

  async start(h: SourceHandlers) {
    h.onStatus(this.status);
    const scan = async () => {
      const t0 = Date.now();
      const networks = await this.scan();
      if (this.stopped) return;
      h.onScan({ networks, durationMs: Date.now() - t0 });
      this.timer = setTimeout(scan, this.intervalSec * 1000);
    };
    scan();
    const link = async () => h.onLink(await this.link());
    link();
    this.linkTimer = setInterval(link, 1000);
  }

  private async scan(): Promise<Observation[]> {
    const args = ["wlan", "show", "networks", "mode=bssid"];
    if (this.iface) args.push(`interface=${this.iface}`);
    const out = await netsh(args, 30000);
    const result: Observation[] = [];
    let ssid: string | null = null;
    let security: string[] = [];
    let cur: Observation | null = null;
    let bandText = "";

    const flush = () => {
      if (cur) {
        cur.band = bandFrom(bandText, cur.channel);
        result.push(cur);
      }
      cur = null;
      bandText = "";
    };

    for (const raw of out.split(/\r?\n/)) {
      const line = raw.trim();
      const ssidM = line.match(/^SSID\s+\d+\s*:\s*(.*)$/i);
      if (ssidM) {
        flush();
        ssid = ssidM[1].trim() || null;
        security = [];
        continue;
      }
      const bssidM = line.match(/^BSSID\s+\d+\s*:\s*([0-9a-f:]{17})/i);
      if (bssidM) {
        flush();
        cur = {
          ssid, bssid: normalizeMac(bssidM[1]), rssi: -90, noise: null, channel: 0, band: "2.4",
          width: 20, security, phy: [], beaconInterval: null,
        };
        continue;
      }
      const idx = line.indexOf(":");
      if (idx < 0) continue;
      const key = ascii(line.slice(0, idx));
      const value = line.slice(idx + 1).trim();
      if (!cur) {
        if (key.startsWith("authentication") || key.startsWith("autentica")) security = securityFromText(value);
        continue;
      }
      if (key === "signal" || key === "sinal") cur.rssi = percentToDbm(parseFloat(value));
      else if (key === "channel" || key === "canal") cur.channel = parseInt(value, 10) || 0;
      else if (key.startsWith("radio type") || key.startsWith("tipo de radio")) cur.phy = phyFromRadio(value);
      else if (key === "band" || key === "banda") bandText = value;
    }
    flush();
    return result.filter((o) => o.channel > 0);
  }

  private async link(): Promise<RawLink | null> {
    const out = await netsh(["wlan", "show", "interfaces"], 5000);
    const kv: Record<string, string> = {};
    for (const raw of out.split(/\r?\n/)) {
      const idx = raw.indexOf(":");
      if (idx < 0) continue;
      kv[ascii(raw.slice(0, idx))] = raw.slice(idx + 1).trim();
    }
    const state = ascii(kv["state"] ?? kv["estado"] ?? "");
    if (!state.includes("connect") && !state.includes("conectad")) return null;
    const channel = parseInt(kv["channel"] ?? kv["canal"] ?? "", 10) || null;
    const signal = parseFloat(kv["signal"] ?? kv["sinal"] ?? "");
    const auth = kv["authentication"] ?? kv["autenticacao"];
    return {
      ...emptyLink(),
      iface: kv["name"] ?? kv["nome"] ?? null,
      ssid: kv["ssid"] ?? null,
      bssid: normalizeMac(kv["bssid"] ?? kv["ap bssid"]),
      rssi: Number.isFinite(signal) ? percentToDbm(signal) : null,
      txRate: parseFloat(kv["transmit rate (mbps)"] ?? kv["taxa de transmissao (mbps)"] ?? "") || null,
      channel,
      band: channel ? bandFrom(kv["band"] ?? kv["banda"] ?? "", channel) : null,
      phy: phyFromRadio(kv["radio type"] ?? kv["tipo de radio"] ?? "")[0] ?? null,
      security: auth ? securityFromText(auth).at(-1) ?? null : null,
      mac: normalizeMac(kv["physical address"] ?? kv["endereco fisico"]),
    };
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.linkTimer) clearInterval(this.linkTimer);
  }
}
