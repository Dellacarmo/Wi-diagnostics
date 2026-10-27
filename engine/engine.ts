/**
 * Wi-Diagnostics engine: picks a scan source, tracks radios, models RF,
 * and publishes a `Snapshot` once per second to any number of subscribers.
 */

import { hostname, type as osType } from "node:os";
import type {
  EnvironmentModel, EnvironmentPreset, LinkView, NetworkView, RawLink, ScanBatch,
  Snapshot, SourceStatus, WiEvent, Band,
} from "./types";
import {
  ENVIRONMENTS, bestPhy, channelFrequency, channelSpan, codename, estimateDistance, generationLabel,
  isRandomizedMac, maxPhyRate, normalizeMac, phyLabel, securityGrade, securityLabel, signalQuality, stats,
} from "./rf";
import { lookupVendor } from "./oui";
import { Tracker, type Track } from "./tracker";
import { Layout, deviceGroup } from "./layout";
import { analyzeSpectrum, interferenceFor, type SpectrumInput } from "./spectrum";
import { PingMonitor, readNetInfo, type NetInfo } from "./netinfo";
import { SyslogListener } from "./syslog";
import type { ScanSource, SourceHandlers } from "./sources/source";
import { DemoSource } from "./sources/demo";
import { MacProfilerSource, MacSource } from "./sources/macos";
import { LinuxSource } from "./sources/linux";
import { WindowsSource } from "./sources/windows";

export const VERSION = "2.0.0";

export interface EngineOptions {
  demo?: boolean;
  env?: EnvironmentPreset;
  interval?: number; // seconds between scans
  iface?: string | null;
  syslogPort?: number | null;
  log?: (msg: string) => void;
}

const MAX_EVENTS = 80;

export class WiEngine {
  env: EnvironmentModel;
  private opts: EngineOptions;
  private source: ScanSource | null = null;
  private sourceStatus: SourceStatus = { kind: "demo", label: "iniciando…", redacted: false, note: null };
  private tracker = new Tracker();
  private layout = new Layout();
  private snapshotListeners = new Set<(s: Snapshot) => void>();
  private eventListeners = new Set<(e: WiEvent) => void>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private events: WiEvent[] = [];
  private eventSeq = 0;
  private throttle = new Map<string, number>();
  private seq = 0;
  private scanSeq = 0;
  private realScans = 0;
  private lastScanAt: number | null = null;
  private lastScanDuration: number | null = null;
  private rawLink: RawLink | null = null;
  private linkHistory: number[] = [];
  private prevLink: { connected: boolean; bssid: string | null; channel: number | null } | null = null;
  private netInfo: NetInfo = { ip: null, ipv6: null, gateway: null, gatewayIface: null, routerMac: null, dns: [] };
  private gwPing = new PingMonitor(null, 1000);
  private inetPing = new PingMonitor("1.1.1.1", 2000);
  private internetDown = false;
  private syslog: SyslogListener | null = null;
  private latest: Snapshot | null = null;
  private publishPending = false;

  constructor(opts: EngineOptions = {}) {
    this.opts = { interval: 2, ...opts };
    this.env = ENVIRONMENTS[opts.env ?? "residential"];
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  async start() {
    const log = this.opts.log ?? (() => {});
    const handlers: SourceHandlers = {
      onScan: (batch, provisional) => this.handleScan(batch, provisional ?? false),
      onLink: (link) => this.handleLink(link),
      onStatus: (status) => {
        this.sourceStatus = status;
      },
      onError: (message) => log(message),
    };

    for (const candidate of this.candidates()) {
      try {
        this.sourceStatus = candidate.status;
        await candidate.start(handlers);
        this.source = candidate;
        break;
      } catch (e) {
        log(`${candidate.status.label}: ${(e as Error).message}`);
      }
    }
    if (!this.source) {
      const demo = new DemoSource(this.opts.interval);
      demo.status.note = "Nenhum scanner disponível nesta plataforma — exibindo dados sintéticos";
      this.sourceStatus = demo.status;
      await demo.start(handlers);
      this.source = demo;
    }
    this.pushEvent("info", "source", `Fonte de dados: ${this.sourceStatus.label}`);

    if (this.sourceStatus.kind === "demo") this.startDemoNetwork();
    else {
      await this.refreshNetInfo();
      this.gwPing.start();
      this.inetPing.start();
      this.timers.push(setInterval(() => this.refreshNetInfo(), 15000));
    }

    if (this.opts.syslogPort) {
      this.syslog = new SyslogListener(this.opts.syslogPort, (level, kind, msg) => this.pushEvent(level, kind, msg));
      try {
        await this.syslog.start();
        this.pushEvent("info", "syslog", `Syslog escutando em UDP :${this.opts.syslogPort}`);
      } catch (e) {
        this.pushEvent("warn", "syslog", `Syslog indisponível: ${(e as Error).message}`);
        this.syslog = null;
      }
    }

    this.timers.push(setInterval(() => this.publish(), 1000));
    this.publish();
  }

  stop() {
    this.source?.stop();
    this.gwPing.stop();
    this.inetPing.stop();
    this.syslog?.stop();
    this.timers.forEach(clearInterval);
  }

  private candidates(): ScanSource[] {
    const interval = this.opts.interval!;
    if (this.opts.demo) return [new DemoSource(interval)];
    switch (process.platform) {
      case "darwin":
        return [new MacSource(interval), new MacProfilerSource(Math.max(interval, 5))];
      case "linux":
        return [new LinuxSource(Math.max(interval, 3), this.opts.iface ?? null)];
      case "win32":
        return [new WindowsSource(Math.max(interval, 3), this.opts.iface ?? null)];
      default:
        return [];
    }
  }

  // ─── Subscriptions ──────────────────────────────────────────────────────

  onSnapshot(fn: (s: Snapshot) => void) {
    this.snapshotListeners.add(fn);
    if (this.latest) fn(this.latest);
    return () => this.snapshotListeners.delete(fn);
  }

  onEvent(fn: (e: WiEvent) => void) {
    this.eventListeners.add(fn);
    return () => this.eventListeners.delete(fn);
  }

  current(): Snapshot {
    return this.latest ?? this.buildSnapshot();
  }

  setEnvironment(preset: EnvironmentPreset) {
    if (!ENVIRONMENTS[preset] || preset === this.env.preset) return;
    this.env = ENVIRONMENTS[preset];
    this.pushEvent("info", "env", `Modelo de propagação: ${this.env.label} (n=${this.env.exponent})`);
    this.publish();
  }

  // ─── Inputs ─────────────────────────────────────────────────────────────

  private handleScan(batch: ScanBatch, provisional: boolean) {
    this.scanSeq++;
    const fresh = this.tracker.ingest(batch.networks, this.scanSeq, provisional);
    if (!provisional) {
      this.realScans++;
      this.lastScanAt = Date.now();
      this.lastScanDuration = batch.durationMs;
      const warmingUp = this.realScans <= 3; // consecutive OS scans disagree a lot at first
      if (this.realScans === 1) {
        this.pushEvent("good", "scan", `Varredura inicial: ${batch.networks.length} rádios detectados`);
      } else if (warmingUp) {
        // fold early discoveries into the initial picture silently
      } else if (fresh.length > 4) {
        this.pushEvent("info", "new", `${fresh.length} novas redes no ar`);
      } else {
        for (const id of fresh) {
          const t = this.tracker.tracks.get(id)!;
          this.pushEvent("info", "new", `Nova rede: ${this.nameOf(t)} · ${t.band} GHz ch ${t.channel}`, id);
        }
      }
      const expiry = Math.max(45000, 4 * ((this.lastScanDuration ?? 0) + this.opts.interval! * 1000));
      for (const t of this.tracker.expire(expiry)) {
        if (t.samples >= 3) this.pushEvent("info", "lost", `Rede fora de alcance: ${this.nameOf(t)}`, t.id);
      }
    }
    this.schedulePublish();
  }

  private handleLink(link: RawLink | null) {
    const prev = this.prevLink;
    const connected = !!link && link.rssi !== null;
    this.rawLink = connected ? link : null;

    if (connected && link!.rssi !== null) {
      this.linkHistory.push(link!.rssi);
      if (this.linkHistory.length > 120) this.linkHistory.shift();
      this.detectSignalDrop();
    }

    if (prev) {
      if (prev.connected && !connected) this.pushEvent("bad", "link", "Wi-Fi desconectado");
      if (!prev.connected && connected) this.pushEvent("good", "link", "Wi-Fi conectado");
      if (connected && prev.connected) {
        if (link!.bssid && prev.bssid && link!.bssid !== prev.bssid) {
          this.pushEvent("warn", "roam", `Roaming para outro AP (${link!.bssid})`);
        } else if (link!.channel && prev.channel && link!.channel !== prev.channel) {
          this.pushEvent("warn", "channel", `AP mudou do canal ${prev.channel} para ${link!.channel}`);
        }
      }
    }
    this.prevLink = { connected, bssid: link?.bssid ?? null, channel: link?.channel ?? null };
  }

  private detectSignalDrop() {
    const h = this.linkHistory;
    if (h.length < 25) return;
    const recent = stats(h.slice(-5)).mean;
    const before = stats(h.slice(-25, -10)).mean;
    if (before - recent >= 10) this.pushEvent("warn", "drop", `Queda de sinal: ${Math.round(before)} → ${Math.round(recent)} dBm`, undefined, 30000);
    if (recent - before >= 10) this.pushEvent("good", "gain", `Sinal melhorou: ${Math.round(before)} → ${Math.round(recent)} dBm`, undefined, 30000);
  }

  private async refreshNetInfo() {
    this.netInfo = await readNetInfo(this.rawLink?.iface ?? null);
    this.gwPing.setTarget(this.netInfo.gateway);
  }

  private startDemoNetwork() {
    this.netInfo = {
      ip: "192.168.0.42",
      ipv6: "2804:14c:5b81:8f00::42",
      gateway: "192.168.0.1",
      gatewayIface: "wlan0",
      routerMac: "50:C7:BF:3A:91:C0",
      dns: ["192.168.0.1", "1.1.1.1"],
    };
    this.gwPing.target = this.netInfo.gateway;
    const jitter = () => (Math.random() - 0.5) * 2;
    this.timers.push(
      setInterval(() => this.gwPing.push(Math.random() < 0.04 ? 38 + Math.random() * 40 : 3.2 + jitter() * 1.6), 1000),
      setInterval(() => this.inetPing.push(Math.random() < 0.02 ? null : 19 + jitter() * 5 + Math.random() * 6), 2000),
    );
  }

  // ─── Events ─────────────────────────────────────────────────────────────

  private pushEvent(level: WiEvent["level"], kind: string, message: string, networkId?: string, minGapMs = 0) {
    const key = `${kind}:${networkId ?? ""}`;
    const now = Date.now();
    if (minGapMs) {
      if (now - (this.throttle.get(key) ?? 0) < minGapMs) return;
      this.throttle.set(key, now);
    }
    const ev: WiEvent = { id: ++this.eventSeq, t: now, level, kind, message, networkId };
    this.events.push(ev);
    if (this.events.length > MAX_EVENTS) this.events.shift();
    for (const fn of this.eventListeners) fn(ev);
  }

  private checkPingEvents() {
    const gw = this.gwPing.stat();
    const trailing = this.inetPing.trailingLoss;
    if (!this.internetDown && trailing >= 3) {
      this.internetDown = true;
      this.pushEvent("bad", "internet", `Internet sem resposta (${this.inetPing.target})`);
    } else if (this.internetDown && trailing === 0 && this.inetPing.stat().last !== null) {
      this.internetDown = false;
      this.pushEvent("good", "internet", "Internet restabelecida");
    }
    if (gw.last !== null && gw.avg !== null && gw.last > Math.max(40, gw.avg * 4)) {
      this.pushEvent("warn", "latency", `Pico de latência no gateway: ${gw.last.toFixed(0)} ms`, undefined, 30000);
    }
  }

  // ─── Snapshot assembly ──────────────────────────────────────────────────

  private nameOf(t: Track): string {
    if (t.ssid) return t.ssid;
    if (this.sourceStatus.redacted && !t.bssid) return codename(t.id);
    return `‹oculta› ${codename(t.id)}`;
  }

  private schedulePublish() {
    if (this.publishPending) return;
    this.publishPending = true;
    queueMicrotask(() => {
      this.publishPending = false;
      this.publish();
    });
  }

  private publish() {
    this.checkPingEvents();
    const snap = this.buildSnapshot();
    this.latest = snap;
    for (const fn of this.snapshotListeners) fn(snap);
  }

  private buildSnapshot(): Snapshot {
    const tracks = [...this.tracker.tracks.values()];
    const groups = new Map(tracks.map((t) => [t.id, deviceGroup(t.bssid, t.ssid)]));
    this.groupAnonymousTwins(tracks, groups);

    const prelim = tracks.map((t) => {
      const recent = [...t.series.values()].slice(-15);
      const std = stats(recent).std;
      const distance = estimateDistance(t.rssi, t.band, this.env, std);
      return { t, std, distance, span: channelSpan(t.channel, t.band, t.width) };
    });

    const positions = this.layout.compute(
      prelim.map((p) => ({
        id: p.t.id,
        group: groups.get(p.t.id) ?? null,
        distance: p.distance.est,
        samples: p.t.samples,
        rssiStd: p.std,
        series: p.t.series,
      })),
    );

    const spectrumInputs: SpectrumInput[] = prelim.map((p) => ({
      id: p.t.id,
      band: p.t.band,
      channel: p.t.channel,
      span: p.span,
      rssi: p.t.rssi,
      group: groups.get(p.t.id) ?? null,
    }));

    const connectedId = this.matchConnected(tracks);

    const networks: NetworkView[] = prelim.map(({ t, std, distance, span }, i) => {
      const noise = t.noise ?? (t.id === connectedId ? this.rawLink?.noise ?? null : null);
      const snr = noise !== null ? Math.round(t.rssi - noise) : null;
      const phy = bestPhy(t.phy);
      return {
        id: t.id,
        name: this.nameOf(t),
        ssid: t.ssid,
        redacted: this.sourceStatus.redacted && !t.ssid,
        hidden: !t.ssid && !this.sourceStatus.redacted,
        bssid: t.bssid,
        vendor: lookupVendor(t.bssid) ?? t.vendorHint,
        randomizedMac: isRandomizedMac(t.bssid),
        group: groups.get(t.id) ?? null,
        band: t.band,
        channel: t.channel,
        width: t.width,
        freq: channelFrequency(t.channel, t.band),
        span,
        rssi: Math.round(t.rssi * 10) / 10,
        rssiRaw: t.rssiRaw,
        rssiStd: Math.round(std * 10) / 10,
        rssiPeak: t.peak,
        noise,
        snr,
        quality: signalQuality(t.rssi, snr),
        history: t.history.map((v) => Math.round(v * 10) / 10),
        distance: {
          est: Math.round(distance.est * 10) / 10,
          min: Math.round(distance.min * 10) / 10,
          max: Math.round(distance.max * 10) / 10,
        },
        position: positions.get(t.id)!,
        security: securityLabel(t.security),
        securityTokens: t.security,
        securityGrade: securityGrade(t.security),
        phy: phyLabel(t.phy),
        generation: generationLabel(phy, t.band),
        maxRate: maxPhyRate(phy, t.width),
        beaconInterval: t.beaconInterval,
        interference: interferenceFor(spectrumInputs[i], spectrumInputs),
        connected: t.id === connectedId,
        stale: t.lastSeq < this.scanSeq && !t.provisional,
        firstSeen: t.firstSeen,
        lastSeen: t.lastSeen,
        samples: t.samples,
      };
    });
    networks.sort((a, b) => Number(b.connected) - Number(a.connected) || b.rssi - a.rssi);

    const spectrum = analyzeSpectrum(spectrumInputs);
    // Channel advice must ignore the user's own AP (and its sibling radios), or it penalizes the current channel.
    const ownGroup = connectedId ? groups.get(connectedId) ?? null : null;
    const foreign = connectedId
      ? analyzeSpectrum(spectrumInputs.filter((s) => s.id !== connectedId && !(ownGroup && s.group === ownGroup)))
      : spectrum;
    const link = this.buildLink(networks.find((n) => n.connected) ?? null, foreign);
    // Loads and counts include every radio; the recommendation shown everywhere ignores the own AP.
    const shownSpectrum = spectrum.map((b, i) => ({ ...b, best: foreign[i].best ?? b.best }));

    const byBand: Record<Band, number> = { "2.4": 0, "5": 0, "6": 0 };
    for (const n of networks) byBand[n.band]++;
    let busiest: Snapshot["stats"]["busiestChannel"] = null;
    for (const b of spectrum)
      for (const c of b.channels)
        if (c.count && (!busiest || c.count > busiest.count)) busiest = { band: b.band, channel: c.channel, count: c.count };
    const visible = networks.filter((n) => !n.stale);

    return {
      t: Date.now(),
      seq: ++this.seq,
      version: VERSION,
      source: this.sourceStatus,
      host: { hostname: hostname(), os: osType(), platform: process.platform },
      scan: {
        count: this.realScans,
        lastAt: this.lastScanAt,
        durationMs: this.lastScanDuration,
        intervalMs: this.opts.interval! * 1000,
      },
      env: this.env,
      networks,
      link,
      spectrum: shownSpectrum,
      events: this.events.slice(-40),
      stats: {
        total: networks.length,
        visible: visible.length,
        byBand,
        avgRssi: visible.length ? Math.round(stats(visible.map((n) => n.rssi)).mean) : null,
        strongest: visible.find((n) => !n.connected)?.id ?? null,
        openNetworks: networks.filter((n) => n.securityGrade === "F").length,
        busiestChannel: busiest,
      },
      syslog: { enabled: !!this.syslog, port: this.syslog?.port ?? null, received: this.syslog?.received ?? 0 },
    };
  }

  /**
   * Without SSID/BSSID, multi-SSID APs (main + guest + IoT on one radio) look like separate
   * networks. Strong radios on the same channel/width within 3 dB of each other are grouped
   * as one probable device.
   */
  private groupAnonymousTwins(tracks: Track[], groups: Map<string, string | null>) {
    const anon = tracks
      .filter((t) => !t.bssid && !t.ssid && t.rssi > -72)
      .sort((a, b) => a.band.localeCompare(b.band) || a.channel - b.channel || a.width - b.width || b.rssi - a.rssi);
    let cluster: Track[] = [];
    const flush = () => {
      if (cluster.length > 1) {
        // Key by smallest id, not the strongest member, so RSSI jitter doesn't flip the group.
        const key = `rf:${cluster.map((t) => t.id).sort()[0]}`;
        for (const t of cluster) groups.set(t.id, key);
      }
      cluster = [];
    };
    for (const t of anon) {
      const head = cluster[0];
      if (head && head.band === t.band && head.channel === t.channel && head.width === t.width && Math.abs(head.rssi - t.rssi) <= 3) cluster.push(t);
      else {
        flush();
        cluster = [t];
      }
    }
    flush();
  }

  /** Finds which tracked radio the host is associated with. */
  private matchConnected(tracks: Track[]): string | null {
    const l = this.rawLink;
    if (!l) return null;
    const lb = normalizeMac(l.bssid);
    if (lb) {
      const t = tracks.find((x) => x.bssid === lb);
      if (t) return t.id;
    }
    // Fallback by channel/RSSI, but never pick a radio whose known BSSID or SSID contradicts the link.
    const candidates = tracks.filter(
      (t) =>
        t.channel === l.channel &&
        (!l.band || t.band === l.band) &&
        (!lb || !t.bssid || t.bssid === lb) &&
        (!l.ssid || !t.ssid || t.ssid === l.ssid),
    );
    if (!candidates.length || l.rssi === null) return null;
    candidates.sort((a, b) => Math.abs(a.rssi - l.rssi!) - Math.abs(b.rssi - l.rssi!));
    return candidates[0].id;
  }

  private buildLink(net: NetworkView | null, spectrum: Snapshot["spectrum"]): LinkView {
    const l = this.rawLink;
    const gw = this.gwPing.stat();
    const inet = this.inetPing.stat();
    const snr = l?.rssi != null && l.noise != null ? l.rssi - l.noise : null;
    const routerVendor = lookupVendor(this.netInfo.routerMac) ?? (this.sourceStatus.kind === "demo" ? "TP-Link" : null);

    let quality: number | null = null;
    let verdict = "Sem conexão Wi-Fi";
    if (l && l.rssi !== null) {
      const sig = signalQuality(l.rssi, snr);
      const lat = gw.avg === null ? 70 : Math.min(Math.max(100 - (gw.avg - 5) * 1.05, 0), 100);
      const loss = Math.min(Math.max(100 - inet.loss * 400, 0), 100);
      quality = Math.round(sig * 0.55 + lat * 0.25 + loss * 0.2);

      const best = spectrum.find((b) => b.band === l.band)?.best;
      // 5/6 GHz recommendations are bonded blocks: don't suggest the spectrum the link already occupies.
      let sameBlock = false;
      if (best && l.band && l.channel != null) {
        if (l.band === "2.4") sameBlock = best.channel === l.channel;
        else {
          const ls = channelSpan(l.channel, l.band, l.width ?? 20);
          sameBlock = ls[0] < best.span[1] && ls[1] > best.span[0];
        }
      }
      if (this.inetPing.trailingLoss >= 3) verdict = gw.last !== null ? "Internet sem resposta — LAN ok, problema no provedor/WAN" : "Gateway sem resposta";
      else if (l.rssi < -75) verdict = "Sinal fraco — aproxime-se do roteador ou use mesh/repetidor";
      else if (net && net.interference.score > 60 && best && !sameBlock)
        verdict = `Canal ${l.channel} congestionado — considere o canal ${best.channel}`;
      else if (inet.loss > 0.05) verdict = `Perda de pacotes de ${(inet.loss * 100).toFixed(0)}% para a internet`;
      else if (gw.jitter !== null && gw.jitter > 20) verdict = "Jitter alto na rede local";
      else if (snr !== null && snr < 20) verdict = "SNR baixo — ruído ou interferência no canal";
      else if (l.rssi >= -60 && (gw.avg ?? 0) < 15) verdict = "Link excelente";
      else verdict = "Link estável";
    }

    return {
      connected: !!l,
      iface: l?.iface ?? this.netInfo.gatewayIface,
      ssid: l?.ssid ?? net?.ssid ?? null,
      bssid: l?.bssid ?? null,
      networkId: net?.id ?? null,
      rssi: l?.rssi ?? null,
      noise: l?.noise ?? null,
      snr,
      txRate: l?.txRate ?? null,
      mcs: l?.mcs ?? null,
      phy: l?.phy ? `802.11${l.phy}` : null,
      generation: l?.phy ? generationLabel(l.phy, l.band) : null,
      channel: l?.channel ?? null,
      band: l?.band ?? null,
      width: l?.width ?? null,
      security: l?.security ? securityLabel([l.security]) : null,
      txPowerDbm: null,
      mac: l?.mac ?? null,
      ip: this.netInfo.ip,
      ipv6: this.netInfo.ipv6,
      gateway: this.netInfo.gateway,
      routerMac: this.netInfo.routerMac,
      routerVendor,
      dns: this.netInfo.dns,
      country: l?.country ?? null,
      quality,
      verdict,
      rssiHistory: this.linkHistory.slice(-90),
      gatewayPing: gw,
      internetPing: inet,
    };
  }
}
