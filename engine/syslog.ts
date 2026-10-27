/**
 * Optional UDP syslog listener for router logs (WAN/PPPoE drops, DHCP, Wi-Fi events).
 */

import type { WiEvent } from "./types";

type Emit = (level: WiEvent["level"], kind: string, message: string) => void;

const PATTERNS: [RegExp, WiEvent["level"], string][] = [
  // Down is checked first: "WAN Connection: … link down" must not read as an up event.
  [/pppoe (down|disconnected)|wan disconnect|\bwan\b.*\b(down|lost|disconnected|(?<!command )fail(ed|ure)?)\b/i, "bad", "wan-down"],
  // netifd logs "Interface 'wan' is setting up now" before every attempt, so that is not "up".
  [/pppoe (up|connected)|\bwan\b.*\b(?<!setting )(up|restored|(re)?connected)\b/i, "good", "wan-up"],
  [/firewall|blocked|denied|attack|intrusion/i, "warn", "firewall"],
  [/deauth|disassoc/i, "warn", "wifi-deauth"],
  [/wifi|wireless|wlan|ssid|associat/i, "info", "wifi"],
  [/dhcp|lease/i, "info", "dhcp"],
];

export class SyslogListener {
  received = 0;
  private socket: { close(): void } | null = null;
  private downSince: number | null = null;

  constructor(
    public port: number,
    private emit: Emit,
  ) {}

  async start() {
    this.socket = await Bun.udpSocket({
      hostname: "0.0.0.0",
      port: this.port,
      socket: {
        data: (_sock, buf, _port, addr) => this.handle(buf.toString().trim(), addr),
      },
    });
  }

  private handle(message: string, from: string) {
    if (!message) return;
    this.received++;
    const text = message.replace(/^<\d+>/, "").slice(0, 160);
    const hit = PATTERNS.find(([re]) => re.test(text));
    const [, level, kind] = hit ?? [null, "info", "syslog"];
    if (kind === "wan-down" && this.downSince === null) this.downSince = Date.now();
    if (kind === "wan-up" && this.downSince !== null) {
      const secs = Math.round((Date.now() - this.downSince) / 1000);
      this.downSince = null;
      this.emit("good", "wan-up", `WAN restabelecida após ${secs}s (${from})`);
      return;
    }
    this.emit(level, kind, `${from}: ${text}`);
  }

  stop() {
    this.socket?.close();
  }
}
