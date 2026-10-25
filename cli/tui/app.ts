/**
 * Full-screen terminal UI: RF radar, link telemetry, network table,
 * spectrum analyzer, event log and a per-network inspector.
 */

import type { Band, NetworkView, Snapshot } from "../../engine/types";
import type { WiEngine } from "../../engine/engine";
import { ENV_ORDER, isDfs, radialScale, rssiLabel } from "../../engine/rf";
import { BOLD, Braille, Screen, mix, textWidth } from "./screen";
import {
  BAND_COLOR, C, GRADE_COLOR, ago, bar, clock, fmtDist, fmtMs, glyph, levelColor, pad, padL,
  rssiColor, sparkline, truncate,
} from "./theme";

type Sort = "signal" | "distance" | "channel" | "name";
const SORTS: Sort[] = ["signal", "distance", "channel", "name"];
const SORT_LABEL: Record<Sort, string> = { signal: "sinal", distance: "distância", channel: "canal", name: "nome" };
const FILTERS: (Band | "all")[] = ["all", "2.4", "5", "6"];
const TAU = Math.PI * 2;
const wrap = (a: number) => ((a % TAU) + TAU) % TAU;

const BAND_TICKS: Record<Band, number[]> = {
  "2.4": [1, 3, 6, 9, 11, 13],
  "5": [36, 52, 64, 100, 116, 132, 149, 165],
  "6": [1, 37, 69, 101, 133, 165, 197, 229],
};

export interface TuiOptions {
  startWeb?: () => Promise<string>;
  webUrl?: string | null;
}

export class Tui {
  private screen = new Screen(C.bg);
  private snap: Snapshot | null = null;
  private selectedId: string | null = null;
  private scroll = 0;
  private detail = false;
  private spectrumBand: Band = "2.4";
  private spectrumBandManual = false;
  private filter: Band | "all" = "all";
  private sort: Sort = "signal";
  private rain = true;
  private paused = false;
  private bootUntil = Date.now() + 1600;
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;
  private toast: { text: string; color: number; until: number } | null = null;
  private webUrl: string | null;
  private rainHeads: { y: number; speed: number; len: number }[] = [];
  private rainGlyphs: string[] = [];
  private lastScanSeen = 0;
  private resolveExit: (() => void) | null = null;

  constructor(
    private engine: WiEngine,
    private opts: TuiOptions = {},
  ) {
    this.webUrl = opts.webUrl ?? null;
  }

  run(): Promise<void> {
    const out = process.stdout;
    out.write("\x1b[?1049h\x1b[?25l\x1b[2J");
    this.resize();
    out.on("resize", () => this.resize());

    const stdin = process.stdin;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    stdin.on("data", (d: string) => this.onKey(d));

    this.unsubscribe = this.engine.onSnapshot((s) => {
      if (!this.paused) this.snap = s;
    });
    this.timer = setInterval(() => this.frame(), 80);
    return new Promise((resolve) => (this.resolveExit = resolve));
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.unsubscribe?.();
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write("\x1b[0m\x1b[?25h\x1b[?1049l");
    this.resolveExit?.();
  }

  private resize() {
    const w = process.stdout.columns || 120;
    const h = process.stdout.rows || 36;
    this.screen.resize(w, h);
    this.rainHeads = Array.from({ length: w }, () => this.newDrop(h, true));
    this.rainGlyphs = Array.from({ length: w * h }, glyph);
  }

  private newDrop(h: number, anywhere = false) {
    return { y: anywhere ? Math.random() * h * 2 - h : -Math.random() * h, speed: 0.25 + Math.random() * 0.9, len: 5 + Math.random() * 18 };
  }

  private notify(text: string, color: number = C.title) {
    this.toast = { text, color, until: Date.now() + 3500 };
  }

  // ─── Input ──────────────────────────────────────────────────────────────

  private onKey(d: string) {
    // Raw mode turns Ctrl+C into "\x03", so quitting must not be eaten by the intro skip.
    if (d === "\x03" || d === "q" || d === "Q") return this.stop();
    if (Date.now() < this.bootUntil) {
      this.bootUntil = 0;
      return;
    }
    const rows = this.rows();
    const idx = Math.max(0, rows.findIndex((n) => n.id === this.selectedId));
    const select = (i: number) => {
      const n = rows[Math.min(Math.max(i, 0), rows.length - 1)];
      if (n) this.selectedId = n.id;
    };

    switch (d) {
      case "\x1b[A":
      case "k":
        return select(idx - 1);
      case "\x1b[B":
      case "j":
        return select(idx + 1);
      case "\x1b[5~":
        return select(idx - 10);
      case "\x1b[6~":
        return select(idx + 10);
      case "\x1b[H":
      case "g":
        return select(0);
      case "\x1b[F":
      case "G":
        return select(rows.length - 1);
      case "\r":
      case " ":
        this.detail = !this.detail;
        return;
      case "\x1b":
        this.detail = false;
        return;
      case "b": {
        const bands: Band[] = ["2.4", "5", "6"];
        this.spectrumBand = bands[(bands.indexOf(this.spectrumBand) + 1) % 3];
        this.spectrumBandManual = true;
        return;
      }
      case "f":
        this.filter = FILTERS[(FILTERS.indexOf(this.filter) + 1) % FILTERS.length];
        this.notify(`filtro: ${this.filter === "all" ? "todas as bandas" : this.filter + " GHz"}`);
        return;
      case "s":
        this.sort = SORTS[(SORTS.indexOf(this.sort) + 1) % SORTS.length];
        this.notify(`ordenando por ${SORT_LABEL[this.sort]}`);
        return;
      case "e": {
        const next = ENV_ORDER[(ENV_ORDER.indexOf(this.engine.env.preset) + 1) % ENV_ORDER.length];
        this.engine.setEnvironment(next);
        this.notify(`modelo: ${this.engine.env.label} (n=${this.engine.env.exponent})`);
        return;
      }
      case "m":
        this.rain = !this.rain;
        return;
      case "p":
        this.paused = !this.paused;
        this.notify(this.paused ? "pausado" : "ao vivo");
        return;
      case "w":
        if (this.webUrl) {
          this.notify(`web em ${this.webUrl}`);
          try {
            Bun.spawn([process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open", this.webUrl], { stdout: "ignore", stderr: "ignore" });
          } catch {
            // no browser opener (headless Linux): the URL is already in the toast
          }
        } else if (this.opts.startWeb) {
          this.notify("iniciando visualização 3D…");
          this.opts.startWeb().then(
            (url) => {
              this.webUrl = url;
              this.notify(`web 3D em ${url}`, C.good);
            },
            (e) => this.notify(`falha ao iniciar web: ${e.message}`, C.bad),
          );
        }
        return;
    }
  }

  private rows(): NetworkView[] {
    const nets = (this.snap?.networks ?? []).filter((n) => this.filter === "all" || n.band === this.filter);
    const by: Record<Sort, (a: NetworkView, b: NetworkView) => number> = {
      signal: (a, b) => Number(b.connected) - Number(a.connected) || b.rssi - a.rssi,
      distance: (a, b) => a.distance.est - b.distance.est,
      channel: (a, b) => a.band.localeCompare(b.band) || a.channel - b.channel,
      name: (a, b) => a.name.localeCompare(b.name),
    };
    return [...nets].sort(by[this.sort]);
  }

  // ─── Frame ──────────────────────────────────────────────────────────────

  private frame() {
    const s = this.screen;
    s.clear();
    const now = Date.now();
    this.stepRain();

    if (now < this.bootUntil || !this.snap) this.drawBoot(now);
    else if (s.w < 96 || s.h < 28) {
      s.text(2, 1, "WI//DIAG", C.title, -1, BOLD);
      s.text(2, 3, `Terminal pequeno demais (${s.w}×${s.h}).`, C.text);
      s.text(2, 4, "Aumente para pelo menos 96×28.", C.dim);
    } else this.drawMain(now);

    process.stdout.write(s.flush());
  }

  private stepRain() {
    const h = this.screen.h;
    for (let i = 0; i < this.rainHeads.length; i++) {
      const d = this.rainHeads[i];
      d.y += d.speed;
      if (d.y - d.len > h) this.rainHeads[i] = this.newDrop(h);
    }
    for (let k = 0; k < this.rainGlyphs.length * 0.02; k++) this.rainGlyphs[(Math.random() * this.rainGlyphs.length) | 0] = glyph();
  }

  /** Rain intensity 0..1 at a cell (1 = drop head). */
  private rainAt(x: number, y: number): number {
    const d = this.rainHeads[x];
    if (!d) return 0;
    const dist = d.y - y;
    if (dist < 0 || dist > d.len) return 0;
    return 1 - dist / d.len;
  }

  private drawRain(x0: number, y0: number, w: number, h: number, strength: number) {
    const s = this.screen;
    for (let y = y0; y < y0 + h; y++)
      for (let x = x0; x < x0 + w; x++) {
        const k = this.rainAt(x, y);
        if (k <= 0.02) continue;
        const color = k > 0.95 ? mix(C.bg, C.bright, strength) : mix(C.bg, C.matrix, k * strength * 0.9);
        s.put(x, y, this.rainGlyphs[y * s.w + x], color);
      }
  }

  private drawBoot(now: number) {
    const s = this.screen;
    this.drawRain(0, 0, s.w, s.h, 0.85);
    const cy = Math.floor(s.h / 2);
    const title = "W I · D I A G N O S T I C S";
    const tx = Math.floor((s.w - title.length) / 2);
    s.fill(tx - 3, cy - 2, title.length + 6, 5, C.bg);
    s.text(tx, cy - 1, title, C.bright, -1, BOLD);
    const sub = this.snap ? "sincronizando com o espectro…" : "acordando os rádios…";
    const dots = ".".repeat(Math.floor(now / 300) % 4);
    s.text(Math.floor((s.w - sub.length) / 2), cy + 1, sub.replace("…", dots.padEnd(3)), C.dim);
  }

  private drawMain(now: number) {
    const s = this.screen;
    const snap = this.snap!;
    const W = s.w;
    const H = s.h;

    if (!this.spectrumBandManual) {
      this.spectrumBand = snap.link.band ?? (snap.stats.byBand["2.4"] ? "2.4" : "5");
    }
    if (snap.scan.count !== this.lastScanSeen) this.lastScanSeen = snap.scan.count;

    const rows = this.rows();
    if (!rows.find((n) => n.id === this.selectedId)) this.selectedId = rows[0]?.id ?? null;
    const selected = snap.networks.find((n) => n.id === this.selectedId) ?? null;

    const mainH = H - 2;
    const bottomH = Math.min(Math.max(Math.floor(mainH * 0.32), 10), 14);
    const topH = mainH - bottomH;
    const leftW = Math.min(Math.max(Math.round((topH - 2) * 2.15) + 2, 46), Math.floor(W * 0.5));
    const rightW = W - leftW;
    const linkH = 9;
    const specW = Math.floor(W * 0.58);

    this.drawHeader(snap, now);
    this.drawRadar(snap, selected, 0, 1, leftW, topH, now);
    this.drawLink(snap, leftW, 1, rightW, linkH);
    this.drawTable(snap, rows, leftW, 1 + linkH, rightW, topH - linkH);
    this.drawSpectrum(snap, selected, 0, 1 + topH, specW, bottomH);
    this.drawEvents(snap, specW, 1 + topH, W - specW, bottomH);
    this.drawFooter(snap, now);
    if (this.detail && selected) this.drawDetail(snap, selected);
  }

  // ─── Header / footer ────────────────────────────────────────────────────

  private drawHeader(snap: Snapshot, now: number) {
    const s = this.screen;
    s.fill(0, 0, s.w, 1, C.panel);
    const right = `${this.webUrl ? "web ▸ " + this.webUrl + "  " : ""}${clock(now)} `;
    const rx = s.w - textWidth(right);
    s.text(rx, 0, right, this.webUrl ? C.info : C.dim, C.panel);

    // Left segments end one cell before the right text: brand/status are clipped, the
    // optional groups after them are drawn whole or skipped.
    const limit = rx - 1;
    let x = 1;
    const seg = (text: string, color: number, attr = 0, gap = 0) => {
      x += s.text(x, 0, text, color, C.panel, attr, Math.max(limit - x, 0)) + gap;
    };
    type Part = [string, number, number?];
    const width = (parts: Part[]) => parts.reduce((n, [t]) => n + textWidth(t), 0);
    const group = (gap: number, parts: Part[], reserve = 0) => {
      if (x + width(parts) + reserve > limit) return false;
      for (const [t, color, attr] of parts) x += s.text(x, 0, t, color, C.panel, attr ?? 0);
      x += gap;
      return true;
    };

    seg("◢◤", C.matrix, BOLD, 1);
    seg("WI//DIAG", C.bright, BOLD, 1);
    seg(`v${snap.version}`, C.dim, 0, 1);
    seg("│", C.border, 0, 1);

    const live = snap.source.kind === "demo" ? "DEMO" : this.paused ? "PAUSA" : "AO VIVO";
    const blink = Math.floor(now / 600) % 2 === 0;
    const liveColor = snap.source.kind === "demo" ? C.warn : this.paused ? C.dim : C.good;
    seg(blink || this.paused ? "●" : "○", liveColor, 0, 1);
    seg(live, liveColor, BOLD, 1);
    seg(snap.source.label, C.text, 0, 2);
    const count: Part[] = [["│ ", C.border], [`${snap.stats.visible}`, C.bright, BOLD], [" rádios", C.dim]];
    // The redaction notice yields to the radio count.
    if (snap.source.redacted) group(2, [["⚠ SSID/BSSID ocultos", C.warn]], 2 + width(count));

    const b = snap.stats.byBand;
    if (!group(1, count)) return;
    if (!group(2, [[`2.4:${b["2.4"]} `, BAND_COLOR["2.4"]], [`5:${b["5"]} `, BAND_COLOR["5"]], [`6:${b["6"]}`, BAND_COLOR["6"]]])) return;
    const scanAge = snap.scan.lastAt ? ago(snap.scan.lastAt) : "—";
    const scan = `scan #${snap.scan.count}`;
    if (!group(0, [[`${scan} · ${snap.scan.durationMs ? (snap.scan.durationMs / 1000).toFixed(1) + "s" : "—"} · há ${scanAge}`, C.dim]])) group(0, [[scan, C.dim]]);
  }

  private drawFooter(snap: Snapshot, now: number) {
    const s = this.screen;
    const y = s.h - 1;
    s.fill(0, y, s.w, 1, C.panel);
    if (this.toast && this.toast.until > now) {
      s.text(1, y, `» ${this.toast.text}`, this.toast.color, C.panel, BOLD);
    } else {
      const keys: [string, string][] = [
        ["↑↓", "selecionar"], ["⏎", "detalhes"], ["f", "filtro"], ["s", "ordenar"], ["b", "espectro"],
        ["e", "ambiente"], ["w", "web 3D"], ["m", "matrix"], ["p", "pausa"], ["q", "sair"],
      ];
      let x = 1;
      for (const [k, label] of keys) {
        if (x + k.length + label.length + 3 > s.w - 40) break;
        x += s.text(x, y, k, C.bright, C.panel, BOLD) + 1;
        x += s.text(x, y, label, C.dim, C.panel) + 2;
      }
    }
    const env = `modelo ${snap.env.label} n=${snap.env.exponent} · ${this.filter === "all" ? "todas" : this.filter + "G"} · ${SORT_LABEL[this.sort]} `;
    s.text(s.w - [...env].length, y, env, C.dim, C.panel);
  }

  // ─── Radar ──────────────────────────────────────────────────────────────

  private drawRadar(snap: Snapshot, selected: NetworkView | null, x: number, y: number, w: number, h: number, now: number) {
    const s = this.screen;
    s.box(x, y, w, h, C.border, "RADAR RF", C.title, "escala log · azimute estimado", C.faint);
    const ix = x + 1;
    const iy = y + 1;
    const iw = w - 2;
    const ih = h - 3; // last inner row is the legend
    if (this.rain) this.drawRain(ix, iy, iw, ih, 0.22);

    const bc = new Braille(iw, ih);
    const cx = bc.pw / 2;
    const cy = bc.ph / 2;
    const R = Math.min(bc.pw, bc.ph) / 2 - 2;

    // Range rings and cross-hair
    const rings = [2, 5, 10, 20, 50];
    for (const m of rings) bc.arc(cx, cy, radialScale(m) * R, 0, TAU, C.border, 0.2, 2);
    bc.line(cx - R, cy, cx + R, cy, C.faint, 0.1, 3);
    bc.line(cx, cy - R, cx, cy + R, C.faint, 0.1, 3);

    // Scan pulse on fresh data
    const age = snap.scan.lastAt ? now - snap.scan.lastAt : Infinity;
    if (age < 1400) bc.arc(cx, cy, (age / 1400) * R, 0, TAU, mix(C.matrix, C.bg, age / 1400), 0.5, 1);

    // Uncertainty band for the selected network
    if (selected) {
      const az = selected.position.azimuth;
      const r0 = radialScale(selected.distance.min) * R;
      const r1 = radialScale(selected.distance.max) * R;
      const col = mix(C.bg, BAND_COLOR[selected.band], 0.55);
      for (let r = r0; r <= r1; r += 2) bc.arc(cx, cy, r, az - 0.28, az + 0.28, col, 0.4, 2);
      bc.arc(cx, cy, r0, az - 0.32, az + 0.32, col, 0.5);
      bc.arc(cx, cy, r1, az - 0.32, az + 0.32, col, 0.5);
    }

    // Sweep with phosphor trail
    const sweep = wrap((now / 1000) * 1.15);
    for (let k = 8; k >= 0; k--) {
      const a = sweep - k * 0.045;
      const col = k === 0 ? C.matrix : mix(C.bg, C.matrix, (1 - k / 9) * 0.55);
      bc.line(cx, cy, cx + R * Math.cos(a), cy + R * Math.sin(a), col, 0.9 - k * 0.08, k === 0 ? 1 : 2);
    }
    bc.blit(s, ix, iy);

    // Ring labels on the east axis
    let ringEnd = 0;
    for (const m of rings) {
      const lx = ix + Math.floor((cx + radialScale(m) * R) / 2) + 1;
      const lbl = `${m}m`;
      // Skip labels that would cross the border or run into the previous one (small radars).
      if (lx + lbl.length > ix + iw || lx <= ringEnd) continue;
      ringEnd = lx + s.text(lx, iy + Math.floor(cy / 4), lbl, C.dim);
    }

    // Blips: every marker first, then labels only where they do not cover a marker.
    const glyphCells = new Set<string>();
    const placed: { n: NetworkView; bx: number; by: number; base: number }[] = [];
    const cx0 = ix + Math.floor(cx / 2);
    const cy0 = iy + Math.floor(cy / 4);
    glyphCells.add(`${cx0},${cy0}`);
    const drawOrder = [...snap.networks].sort((a, b) => Number(a.id === this.selectedId) - Number(b.id === this.selectedId) || Number(a.connected) - Number(b.connected));
    for (const n of drawOrder) {
      const r = radialScale(n.distance.est) * R;
      const az = n.position.azimuth;
      const bx = ix + Math.floor((cx + r * Math.cos(az)) / 2);
      const by = iy + Math.floor((cy + r * Math.sin(az)) / 4);
      if (bx < ix || bx >= ix + iw || by < iy || by >= iy + ih) continue;
      const since = wrap(sweep - az);
      const glow = 0.35 + 0.65 * Math.exp(-since * 1.4);
      const dimmed = n.stale || (this.filter !== "all" && n.band !== this.filter);
      const base = n.connected ? C.link : BAND_COLOR[n.band];
      const color = dimmed ? C.faint : n.id === this.selectedId ? C.bright : mix(C.bg, base, glow);
      const g = n.id === this.selectedId ? "◉" : n.connected ? "◆" : n.rssi > -62 ? "●" : "•";
      s.put(bx, by, g, color, -1, n.id === this.selectedId ? BOLD : 0);
      glyphCells.add(`${bx},${by}`);
      if (!dimmed) placed.push({ n, bx, by, base });
    }

    const priority = (n: NetworkView) => (n.id === this.selectedId ? 3 : n.connected ? 2 : 1);
    const labelled = placed
      .filter(({ n }) => n.id === this.selectedId || n.connected || snap.networks.filter((m) => !m.stale).slice(0, 4).includes(n))
      .sort((a, b) => priority(b.n) - priority(a.n) || b.n.rssi - a.n.rssi);
    const taken = new Set<string>();
    for (const { n, bx, by, base } of labelled) {
      const label = truncate(n.name, 14);
      const len = textWidth(label);
      // Try right of the marker, then left of it.
      for (const lx of [bx + 2, bx - 1 - len]) {
        if (lx < ix || lx + len > ix + iw) continue;
        // Text cells must avoid markers and labels; the one-cell margins only other labels.
        const blocked = (x: number, margin: boolean) => taken.has(`${x},${by}`) || (!margin && glyphCells.has(`${x},${by}`));
        let free = true;
        for (let k = -1; k <= len; k++) if (blocked(lx + k, k < 0 || k === len)) free = false;
        if (!free) continue;
        const sel = n.id === this.selectedId;
        s.text(lx, by, label, sel ? C.bright : mix(C.bg, base, 0.75), -1, sel ? BOLD : 0);
        for (let k = -1; k <= len; k++) taken.add(`${lx + k},${by}`);
        break;
      }
    }

    // Receiver
    s.put(cx0, cy0, "◈", C.receiver, -1, BOLD);

    // Legend: trailing items are dropped when the panel is too narrow for them.
    const ly = y + h - 2;
    let lx = ix + 1;
    const legend: [string, number, string][] = [
      ["●", BAND_COLOR["2.4"], "2.4 GHz"],
      ["●", BAND_COLOR["5"], "5 GHz"],
      ["●", BAND_COLOR["6"], "6 GHz"],
      ["◆", C.link, "conectado"],
      ["◈", C.receiver, "você"],
    ];
    for (const [g, color, label] of legend) {
      if (lx + 2 + textWidth(label) > ix + iw) break;
      s.put(lx, ly, g, color);
      lx += s.text(lx + 2, ly, label, C.dim) + 4;
    }
  }

  // ─── Link panel ─────────────────────────────────────────────────────────

  private drawLink(snap: Snapshot, x: number, y: number, w: number, h: number) {
    const s = this.screen;
    const l = snap.link;
    const status = l.connected ? "CONECTADO" : "DESCONECTADO";
    s.box(x, y, w, h, l.connected ? C.borderHi : C.border, "LINK", C.title, status, l.connected ? C.good : C.bad);
    const ix = x + 2;
    const iw = w - 4;
    let row = y + 1;

    const net = snap.networks.find((n) => n.id === l.networkId);
    if (!l.connected) {
      s.text(ix, row + 2, "Sem associação Wi-Fi ativa.", C.dim);
      s.text(ix, row + 3, `IP ${l.ip ?? "—"} · gateway ${l.gateway ?? "—"}`, C.dim);
      return;
    }

    // 1. identity
    let cx = ix;
    cx += s.text(cx, row, truncate(l.ssid ?? net?.name ?? "—", 26), C.link, -1, BOLD) + 1;
    cx += s.text(cx, row, "◆", C.link) + 2;
    s.text(cx, row, `${l.band ?? "?"} GHz · ch ${l.channel ?? "?"}${l.channel && l.band && isDfs(l.channel, l.band) ? " (DFS)" : ""} · ${l.width ?? "?"} MHz · ${l.generation ?? ""}`, C.text, -1, 0, ix + iw - cx);
    row++;

    // 2. signal bar
    cx = ix;
    const rssi = l.rssi ?? -100;
    cx += s.text(cx, row, "RSSI ", C.dim);
    cx += s.text(cx, row, `${rssi}`, rssiColor(rssi), -1, BOLD);
    cx += s.text(cx, row, " dBm ", C.dim);
    const bw = Math.max(Math.min(iw - 42, 26), 8);
    const { full, empty } = bar((rssi + 95) / 65, bw);
    cx += s.text(cx, row, full, rssiColor(rssi));
    cx += s.text(cx, row, empty, C.faint) + 2;
    cx += s.text(cx, row, "SNR ", C.dim);
    cx += s.text(cx, row, l.snr !== null ? `${l.snr} dB` : "—", l.snr !== null && l.snr >= 25 ? C.good : C.warn) + 2;
    s.text(cx, row, rssiLabel(rssi), rssiColor(rssi), -1, 0, ix + iw - cx);
    row++;

    // 3. PHY
    const phy = [
      l.txRate !== null ? `TX ${Math.round(l.txRate)} Mbps` : null,
      l.mcs !== null ? `MCS ${l.mcs}` : null,
      l.phy,
      l.security,
      l.noise !== null ? `ruído ${l.noise} dBm` : null,
      net?.maxRate ? `máx teórico ~${net.maxRate} Mbps` : null,
    ].filter(Boolean).join(" · ");
    s.text(ix, row, phy, C.text, -1, 0, iw);
    row++;

    // 4-5. pings
    for (const [label, p] of [["GW ", l.gatewayPing], ["NET", l.internetPing]] as const) {
      cx = ix;
      cx += s.text(cx, row, label, C.dim) + 1;
      cx += s.text(cx, row, pad(p.target ?? "—", 15), C.text);
      const lastColor = p.last === null ? C.bad : p.last < 20 ? C.good : p.last < 60 ? C.warn : C.bad;
      cx += s.text(cx, row, padL(fmtMs(p.last), 7), lastColor, -1, BOLD) + 1;
      const sw = Math.max(Math.min(iw - 50, 24), 6);
      const hist = p.history.slice(-sw);
      const hi = Math.max(10, ...hist.filter((v): v is number => v !== null));
      cx += s.text(cx, row, sparkline(hist, sw, 0, hi), lastColor) + 1;
      s.text(cx, row, `méd ${fmtMs(p.avg)} jit ${fmtMs(p.jitter)} perda ${(p.loss * 100).toFixed(0)}%`, C.dim, -1, 0, ix + iw - cx);
      row++;
    }

    // 6. addressing
    const addr = [`IP ${l.ip ?? "—"}`, l.dns.length ? `DNS ${l.dns.slice(0, 2).join(", ")}` : null, l.routerMac ? `roteador ${l.routerVendor ?? l.routerMac}` : null]
      .filter(Boolean)
      .join(" · ");
    s.text(ix, row, addr, C.dim, -1, 0, iw);
    row++;

    // 7. verdict + score
    const q = l.quality ?? 0;
    const qColor = q >= 75 ? C.good : q >= 50 ? C.warn : C.bad;
    const score = `QUALIDADE ${q}/100`;
    s.text(ix, row, `▶ ${l.verdict}`, qColor, -1, BOLD, iw - score.length - 2);
    s.text(ix + iw - score.length, row, score, qColor, -1, BOLD);
  }

  // ─── Network table ──────────────────────────────────────────────────────

  private drawTable(snap: Snapshot, rows: NetworkView[], x: number, y: number, w: number, h: number) {
    const s = this.screen;
    const right = `${rows.length} de ${snap.networks.length} · ${SORT_LABEL[this.sort]}`;
    s.box(x, y, w, h, C.border, "REDES", C.title, right, C.dim);
    const ix = x + 1;
    const iw = w - 2;
    const bodyH = h - 3;

    const cols = { mark: 2, band: 6, ch: 5, width: 6, rssi: 14, trend: 0, dist: 8, grade: 4, gen: 0, vendor: 0, name: 0 };
    let rest = iw - (cols.mark + cols.band + cols.ch + cols.width + cols.rssi + cols.dist + cols.grade);
    // Optional columns, in priority order, while the name keeps at least 18 cells.
    for (const [key, width] of [["trend", 13], ["gen", 10], ["vendor", 14]] as const) {
      if (rest - width >= 18) {
        cols[key] = width;
        rest -= width;
      }
    }
    // Narrow panels (W ≈ 96–112) drop the RSSI bar so the name keeps 10 cells and SEG stays visible.
    if (rest < 10) {
      cols.rssi = 5;
      rest += 9;
    }
    cols.name = Math.max(rest, 10);
    const end = ix + iw;

    let hx = ix;
    const head = (label: string, width: number, alignRight = false) => {
      if (!width) return;
      s.text(hx, y + 1, alignRight ? padL(label, width - 1) : pad(label, width), C.dim, -1, BOLD, end - hx);
      hx += width;
    };
    head("", cols.mark);
    head("REDE", cols.name);
    head("BANDA", cols.band);
    head("CH", cols.ch);
    head("LARG", cols.width);
    head(cols.rssi >= 14 ? "SINAL" : "RSSI", cols.rssi);
    head("TENDÊNCIA", cols.trend);
    head("DIST", cols.dist);
    head("SEG", cols.grade);
    head("GERAÇÃO", cols.gen);
    head("FABRICANTE", cols.vendor);

    const selIdx = Math.max(0, rows.findIndex((n) => n.id === this.selectedId));
    if (selIdx < this.scroll) this.scroll = selIdx;
    if (selIdx >= this.scroll + bodyH) this.scroll = selIdx - bodyH + 1;
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(rows.length - bodyH, 0)));

    rows.slice(this.scroll, this.scroll + bodyH).forEach((n, i) => {
      const ry = y + 2 + i;
      const sel = n.id === this.selectedId;
      const bg = sel ? C.select : -1;
      if (sel) s.fill(ix, ry, iw, 1, C.select);
      const fade = n.stale ? 0.45 : 1;
      const tc = mix(C.bg, n.connected ? C.link : C.text, fade);
      let cx = ix;
      const cell = (text: string, width: number, color: number, attr = 0) => {
        if (!width) return;
        s.text(cx, ry, pad(text, width - 1), color, bg, attr, end - cx);
        cx += width;
      };
      cell(sel ? "▸" : n.connected ? "◆" : " ", cols.mark, sel ? C.bright : C.link, BOLD);
      cell(n.name, cols.name, sel ? C.bright : tc, sel || n.connected ? BOLD : 0);
      cell(`${n.band}G`, cols.band, mix(C.bg, BAND_COLOR[n.band], fade));
      cell(String(n.channel), cols.ch, tc);
      cell(`${n.width}M`, cols.width, mix(C.bg, C.dim, fade));
      const rc = mix(C.bg, rssiColor(n.rssi), fade);
      s.text(cx, ry, padL(String(Math.round(n.rssi)), 4), rc, bg, BOLD, end - cx);
      if (cols.rssi >= 14) {
        const { full, empty } = bar((n.rssi + 95) / 65, 8);
        s.text(cx + 5, ry, full, rc, bg, 0, end - cx - 5);
        s.text(cx + 5 + [...full].length, ry, empty, C.faint, bg, 0, end - cx - 5 - [...full].length);
      }
      cx += cols.rssi;
      if (cols.trend) {
        s.text(cx, ry, sparkline(n.history, cols.trend - 1, -95, -30), mix(C.bg, BAND_COLOR[n.band], fade * 0.8), bg, 0, end - cx);
        cx += cols.trend;
      }
      cell(`~${fmtDist(n.distance.est)}`, cols.dist, tc);
      cell(n.securityGrade, cols.grade, mix(C.bg, GRADE_COLOR[n.securityGrade], fade), BOLD);
      cell(n.generation, cols.gen, mix(C.bg, C.dim, fade));
      cell(n.vendor ?? (n.randomizedMac ? "MAC aleatório" : "—"), cols.vendor, mix(C.bg, C.dim, fade));
    });

    if (!rows.length) s.text(ix + 2, y + 3, "aguardando varredura…", C.dim);
    const hint = snap.source.note;
    if (hint) s.text(ix + 1, y + h - 1, ` ${truncate(hint, iw - 4)} `, C.warn);
  }

  // ─── Spectrum ───────────────────────────────────────────────────────────

  private drawSpectrum(snap: Snapshot, selected: NetworkView | null, x: number, y: number, w: number, h: number) {
    const s = this.screen;
    const band = this.spectrumBand;
    const spec = snap.spectrum.find((b) => b.band === band)!;
    const best = spec.best ? `melhor canal ▲ ${spec.best.channel} (${spec.best.width} MHz)` : "sem redes nesta banda";
    s.box(x, y, w, h, C.border, `ESPECTRO · ${band} GHz`, C.title, best, spec.best ? C.good : C.dim);

    const axisW = 4;
    const ix = x + 1 + axisW;
    const iy = y + 1;
    const iw = w - 2 - axisW;
    const ih = h - 3;
    const bc = new Braille(iw, ih);
    const [lo, hi] = spec.range;
    const fx = (f: number) => ((f - lo) / (hi - lo)) * (bc.pw - 1);
    const fy = (dbm: number) => (bc.ph - 1) - Math.min(Math.max((dbm + 100) / 72, 0), 1) * (bc.ph - 1);

    for (const db of [-30, -50, -70, -90]) {
      bc.line(0, fy(db), bc.pw - 1, fy(db), C.ghost, 0.05, 4);
      s.text(x + 1, iy + Math.floor(fy(db) / 4), padL(String(db), axisW - 1), C.faint);
    }
    if (spec.best) {
      const c = spec.channels.find((ch) => ch.channel === spec.best!.channel);
      if (c) bc.line(fx(c.freq), 0, fx(c.freq), bc.ph - 1, mix(C.bg, C.good, 0.45), 0.1, 3);
    }

    const nets = snap.networks.filter((n) => n.band === band).sort((a, b) => a.rssi - b.rssi);
    const labels: { lx: number; ly: number; text: string; color: number }[] = [];
    for (const n of nets) {
      const x0 = fx(n.span[0]);
      const x1 = fx(n.span[1]);
      const top = fy(n.rssi);
      const base = bc.ph - 1;
      const isSel = n.id === selected?.id;
      const color = isSel ? C.bright : n.connected ? C.link : mix(C.bg, BAND_COLOR[band], n.stale ? 0.3 : 0.45 + 0.5 * ((n.rssi + 95) / 65));
      const weight = isSel ? 1 : n.connected ? 0.9 : 0.3 + (n.rssi + 100) / 200;
      let px = x0;
      let py = base;
      const steps = Math.max(Math.ceil(x1 - x0), 2);
      for (let i = 0; i <= steps; i++) {
        const u = (i / steps) * 2 - 1;
        const shape = band === "2.4" ? 0.5 * (1 + Math.cos(Math.PI * u)) : Math.min(1, (1 - Math.abs(u)) / 0.12);
        const qx = x0 + (x1 - x0) * (i / steps);
        const qy = base - (base - top) * Math.max(shape, 0);
        bc.line(px, py, qx, qy, color, weight);
        px = qx;
        py = qy;
      }
      if (isSel || n.connected) {
        const text = truncate(n.name, 12);
        const len = textWidth(text);
        const lx = ix + Math.floor((x0 + x1) / 4) - Math.floor(len / 2);
        const ly = iy + Math.max(Math.floor(top / 4) - 1, 0);
        labels.push({ lx: Math.max(Math.min(lx, ix + iw - len), ix), ly, text, color: isSel ? C.bright : C.link });
      }
    }
    bc.blit(s, ix, iy);
    // Labels go on top of the braille layer so gridline and curve dots cannot replace their letters.
    for (const l of labels) s.text(l.lx, l.ly, l.text, l.color, -1, BOLD, ix + iw - l.lx);

    // Channel axis
    const ay = y + h - 2;
    for (const ch of BAND_TICKS[band]) {
      const c = spec.channels.find((k) => k.channel === ch);
      if (!c) continue;
      const cxp = ix + Math.floor(fx(c.freq) / 2);
      const isBest = spec.best?.channel === ch;
      s.text(cxp - Math.floor(String(ch).length / 2), ay, String(ch), isBest ? C.good : C.dim, -1, isBest ? BOLD : 0);
    }
    s.text(x + 1, ay, " ch", C.faint);
  }

  // ─── Events ─────────────────────────────────────────────────────────────

  private drawEvents(snap: Snapshot, x: number, y: number, w: number, h: number) {
    const s = this.screen;
    const right = snap.syslog.enabled ? `syslog :${snap.syslog.port} · ${snap.syslog.received}` : `${snap.events.length}`;
    s.box(x, y, w, h, C.border, "EVENTOS", C.title, right, C.dim);
    const events = [...snap.events].reverse().slice(0, h - 2);
    events.forEach((e, i) => {
      const ry = y + 1 + i;
      const fade = Math.max(0.45, 1 - i * 0.07);
      s.text(x + 2, ry, clock(e.t).slice(0, 8), mix(C.bg, C.dim, fade));
      s.put(x + 11, ry, "●", mix(C.bg, levelColor(e.level), fade));
      s.text(x + 13, ry, e.message, mix(C.bg, C.text, fade), -1, 0, w - 15);
    });
  }

  // ─── Inspector overlay ──────────────────────────────────────────────────

  private drawDetail(snap: Snapshot, n: NetworkView) {
    const s = this.screen;
    const w = Math.min(84, s.w - 6);
    const h = Math.min(27, s.h - 4);
    const x = Math.floor((s.w - w) / 2);
    const y = Math.floor((s.h - h) / 2);
    s.fill(x, y, w, h, C.panel);
    s.box(x, y, w, h, BAND_COLOR[n.band], truncate(n.name, w - 30), C.bright, n.connected ? "◆ CONECTADA" : "esc fecha", n.connected ? C.link : C.dim);

    const kx = x + 2;
    const vx = x + 17;
    const vw = w - 19;
    let row = y + 1;
    const line = (key: string, value: string, color: number = C.text) => {
      if (row >= y + h - 7) return;
      s.text(kx, row, key, C.dim, C.panel);
      s.text(vx, row, value, color, C.panel, 0, vw);
      row++;
    };
    const names = (ids: string[]) => ids.map((id) => snap.networks.find((m) => m.id === id)?.name).filter(Boolean).join(", ") || "—";

    line("SSID", n.ssid ?? (n.redacted ? "oculto pelo macOS (rode `bun run authorize`)" : "rede oculta"), n.ssid ? C.bright : C.warn);
    line("BSSID", `${n.bssid ?? "—"}${n.randomizedMac ? "  (MAC aleatório/local)" : ""}${n.vendor ? "  · " + n.vendor : ""}`);
    line("Canal", `${n.band} GHz · ch ${n.channel}${isDfs(n.channel, n.band) ? " (DFS)" : ""} · ${n.freq} MHz · largura ${n.width} MHz · ocupa ${n.span[0]}–${n.span[1]} MHz`);
    line("Sinal", `${Math.round(n.rssi)} dBm · pico ${n.rssiPeak} · σ ${n.rssiStd} dB · ${rssiLabel(n.rssi)} · qualidade ${n.quality}%`, rssiColor(n.rssi));
    line("SNR / ruído", n.snr !== null ? `${n.snr} dB · ruído ${n.noise} dBm` : "— (o SO não reporta ruído desta rede)");
    line("Distância", `~${fmtDist(n.distance.est)}  (faixa ${fmtDist(n.distance.min)} – ${fmtDist(n.distance.max)}, modelo ${snap.env.label} n=${snap.env.exponent})`, C.bright);
    line("Posição", `azimute ${Math.round((n.position.azimuth * 180) / Math.PI)}° (estimado) · altura ${n.position.y.toFixed(1)} m · confiança ${Math.round(n.position.confidence * 100)}%`);
    line("Segurança", `${n.security}  [${n.securityGrade}]`, GRADE_COLOR[n.securityGrade]);
    line("PHY", `${n.phy} · ${n.generation}${n.maxRate ? ` · máx teórico ~${n.maxRate} Mbps (2×2)` : ""}${n.beaconInterval ? ` · beacon ${n.beaconInterval} TU` : ""}`);
    const it = n.interference;
    line("Interferência", `${it.score}/100 · SIR ${it.sir ?? "—"} dB · ${it.cochannel} co-canal · ${it.overlapping} sobreposição parcial`, it.score > 60 ? C.bad : it.score > 30 ? C.warn : C.good);
    line("Vizinhos", names(it.neighbors));
    line("Observado", `há ${ago(n.firstSeen)} · última vez há ${ago(n.lastSeen)} · ${n.samples} amostras${n.stale ? " · fora do último scan" : ""}`);

    // RSSI history chart
    const chartH = Math.max(h - (row - y) - 2, 3);
    const cy = y + h - chartH - 1;
    s.text(kx, cy - 1 >= row ? cy - 1 : cy, "histórico RSSI", C.dim, C.panel);
    const cw = w - 10;
    const bc = new Braille(cw, chartH);
    const hist = n.history;
    const lo = Math.floor(Math.min(...hist)) - 6;
    const hi = Math.ceil(Math.max(...hist)) + 6;
    const fy = (v: number) => (bc.ph - 1) - ((v - lo) / (hi - lo)) * (bc.ph - 1);
    for (let i = 1; i < hist.length; i++) {
      const x0 = ((i - 1) / Math.max(hist.length - 1, 1)) * (bc.pw - 1);
      const x1 = (i / Math.max(hist.length - 1, 1)) * (bc.pw - 1);
      bc.line(x0, fy(hist[i - 1]), x1, fy(hist[i]), rssiColor(hist[i]));
    }
    bc.blit(s, x + 8, cy);
    s.text(x + 2, cy, padL(String(Math.round(hi)), 4), C.faint, C.panel);
    s.text(x + 2, cy + chartH - 1, padL(String(Math.round(lo)), 4), C.faint, C.panel);
  }
}
