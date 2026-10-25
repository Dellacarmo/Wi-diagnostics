/**
 * Minimal double-buffered terminal renderer: a cell grid with truecolor styles
 * that flushes only the cells that changed since the previous frame.
 */

export const BOLD = 1;
export const DIM = 2;

const truecolor = /truecolor|24bit/i.test(process.env.COLORTERM ?? "") || process.env.TERM_PROGRAM === "iTerm.app" || process.env.TERM_PROGRAM === "WezTerm";

function to256(rgb: number): number {
  const r = (rgb >> 16) & 255;
  const g = (rgb >> 8) & 255;
  const b = rgb & 255;
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round(((r - 8) / 247) * 24) + 232;
  }
  const q = (v: number) => Math.round((v / 255) * 5);
  return 16 + 36 * q(r) + 6 * q(g) + q(b);
}

const fgCode = (c: number) => (truecolor ? `38;2;${(c >> 16) & 255};${(c >> 8) & 255};${c & 255}` : `38;5;${to256(c)}`);
const bgCode = (c: number) => (truecolor ? `48;2;${(c >> 16) & 255};${(c >> 8) & 255};${c & 255}` : `48;5;${to256(c)}`);

export function mix(a: number, b: number, t: number): number {
  const k = Math.min(Math.max(t, 0), 1);
  const r = ((a >> 16) & 255) + ((((b >> 16) & 255) - ((a >> 16) & 255)) * k);
  const g = ((a >> 8) & 255) + ((((b >> 8) & 255) - ((a >> 8) & 255)) * k);
  const bl = (a & 255) + (((b & 255) - (a & 255)) * k);
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(bl);
}

// SSIDs and syslog text are attacker-controlled: C0/C1 controls (ESC, BEL, TAB, CR…) and
// line separators would reprogram or move the terminal cursor.
const CONTROL = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/;
const PRINTABLE = /^[\x20-\x7e]*$/;
const COMBINING = /^[\p{Mn}\p{Me}]$/u;
// Variation selectors and skin tones change an emoji's width differently per terminal.
const UNSTABLE = /^[\ufe00-\ufe0f\u{1f3fb}-\u{1f3ff}\u{e0100}-\u{e01ef}]$/u;

/**
 * Splits text into terminal glyphs with their cell width (1 or 2). Controls become "?",
 * combining marks stay on their base glyph, other zero-width code points (ZWJ, bidi
 * overrides) and width-unstable ones are dropped, and flag letters are spelled out, so the
 * grid always agrees with where the terminal leaves its cursor.
 */
export function glyphs(s: string): [string, number][] {
  const out: [string, number][] = [];
  for (const c of s.normalize("NFC")) {
    const k = c.codePointAt(0)!;
    let w = 0;
    if (CONTROL.test(c)) out.push(["?", 1]);
    else if (k >= 0x1f1e6 && k <= 0x1f1ff) out.push([String.fromCharCode(k - 0x1f1e6 + 65), 1]);
    else if (UNSTABLE.test(c)) continue;
    else if (COMBINING.test(c)) {
      if (out.length) out[out.length - 1][0] += c;
    } else if ((w = Bun.stringWidth(c)) > 0) out.push([c, Math.min(w, 2)]);
  }
  return out;
}

/** Number of terminal cells `s` occupies when drawn with Screen.text. */
export function textWidth(s: string): number {
  if (PRINTABLE.test(s)) return s.length;
  let n = 0;
  for (const g of glyphs(s)) n += g[1];
  return n;
}

export class Screen {
  w = 0;
  h = 0;
  private ch: string[] = [];
  private fg = new Int32Array(0);
  private bg = new Int32Array(0);
  private at = new Uint8Array(0);
  private pch: string[] = [];
  private pfg = new Int32Array(0);
  private pbg = new Int32Array(0);
  private pat = new Uint8Array(0);
  private full = true;

  constructor(public background: number) {}

  resize(w: number, h: number) {
    this.w = w;
    this.h = h;
    const n = w * h;
    this.ch = new Array(n).fill(" ");
    this.fg = new Int32Array(n);
    this.bg = new Int32Array(n).fill(this.background);
    this.at = new Uint8Array(n);
    this.pch = new Array(n).fill("");
    this.pfg = new Int32Array(n).fill(-1);
    this.pbg = new Int32Array(n).fill(-1);
    this.pat = new Uint8Array(n);
    this.full = true;
  }

  clear() {
    this.ch.fill(" ");
    this.fg.fill(0);
    this.bg.fill(this.background);
    this.at.fill(0);
  }

  put(x: number, y: number, c: string, fg: number, bg = -1, attr = 0) {
    x |= 0;
    y |= 0;
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = y * this.w + x;
    if (CONTROL.test(c)) c = "?";
    // A wide glyph spans its cell and an empty continuation cell; overwriting either half
    // orphans the other, so blank it.
    if (this.ch[i] === "") this.ch[i - 1] = " ";
    else if (x + 1 < this.w && this.ch[i + 1] === "") this.ch[i + 1] = " ";
    this.ch[i] = c;
    this.fg[i] = fg;
    if (bg >= 0) this.bg[i] = bg;
    this.at[i] = attr;
  }

  private putWide(x: number, y: number, c: string, fg: number, bg: number, attr: number) {
    if (x < 0 || y < 0 || x + 1 >= this.w || y >= this.h) return;
    this.put(x, y, c, fg, bg, attr);
    this.put(x + 1, y, " ", fg, bg, attr);
    this.ch[y * this.w + x + 1] = "";
  }

  get(x: number, y: number): string {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return "";
    return this.ch[y * this.w + x];
  }

  /** Writes text clipped to `max` cells; returns the number of cells used. */
  text(x: number, y: number, s: string, fg: number, bg = -1, attr = 0, max = Infinity): number {
    let n = 0;
    if (PRINTABLE.test(s)) {
      for (const c of s) {
        if (n >= max) break;
        this.put(x + n, y, c, fg, bg, attr);
        n++;
      }
      return n;
    }
    for (const [c, w] of glyphs(s)) {
      if (n + w > max) break;
      if (w === 2) this.putWide(x + n, y, c, fg, bg, attr);
      else this.put(x + n, y, c, fg, bg, attr);
      n += w;
    }
    return n;
  }

  fill(x: number, y: number, w: number, h: number, bg: number, c = " ", fg = 0) {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) this.put(xx, yy, c, fg, bg);
  }

  box(x: number, y: number, w: number, h: number, color: number, title?: string, titleColor?: number, right?: string, rightColor?: number) {
    if (w < 2 || h < 2) return;
    this.put(x, y, "╭", color);
    this.put(x + w - 1, y, "╮", color);
    this.put(x, y + h - 1, "╰", color);
    this.put(x + w - 1, y + h - 1, "╯", color);
    for (let i = 1; i < w - 1; i++) {
      this.put(x + i, y, "─", color);
      this.put(x + i, y + h - 1, "─", color);
    }
    for (let j = 1; j < h - 1; j++) {
      this.put(x, y + j, "│", color);
      this.put(x + w - 1, y + j, "│", color);
    }
    if (title) {
      this.put(x + 1, y, " ", color);
      const n = this.text(x + 2, y, title, titleColor ?? color, -1, BOLD, w - 6);
      this.put(x + 2 + n, y, " ", color);
    }
    if (right) {
      const len = textWidth(right);
      const rx = x + w - len - 3;
      if (rx > x + 4) {
        this.put(rx - 1, y, " ", color);
        this.text(rx, y, right, rightColor ?? color);
        this.put(rx + len, y, " ", color);
      }
    }
  }

  flush(): string {
    let out = "\x1b[?2026h";
    let lastStyle = "";
    let cursor = -1;
    for (let i = 0; i < this.ch.length; i++) {
      if (!this.full && this.ch[i] === this.pch[i] && this.fg[i] === this.pfg[i] && this.bg[i] === this.pbg[i] && this.at[i] === this.pat[i]) continue;
      this.pch[i] = this.ch[i];
      this.pfg[i] = this.fg[i];
      this.pbg[i] = this.bg[i];
      this.pat[i] = this.at[i];
      // Continuation cell: the terminal filled it when it drew the wide glyph on its left.
      if (this.ch[i] === "") continue;
      if (cursor !== i) {
        out += `\x1b[${Math.floor(i / this.w) + 1};${(i % this.w) + 1}H`;
      }
      const a = this.at[i];
      const style = `0;${a & BOLD ? "1;" : ""}${a & DIM ? "2;" : ""}${fgCode(this.fg[i])};${bgCode(this.bg[i])}`;
      if (style !== lastStyle) {
        out += `\x1b[${style}m`;
        lastStyle = style;
      }
      out += this.ch[i];
      // Re-address after a wide glyph so a terminal with a different width table cannot shift the row.
      cursor = this.ch[i + 1] === "" ? -1 : i + 1;
    }
    this.full = false;
    return out + "\x1b[0m\x1b[?2026l";
  }

  invalidate() {
    this.full = true;
  }
}

// ─── Braille canvas (2×4 sub-pixels per cell) ──────────────────────────────

const DOTS = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
];

export class Braille {
  readonly pw: number;
  readonly ph: number;
  private mask: Uint8Array;
  private color: Int32Array;
  private weight: Float32Array;

  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.pw = w * 2;
    this.ph = h * 4;
    this.mask = new Uint8Array(w * h);
    this.color = new Int32Array(w * h);
    this.weight = new Float32Array(w * h);
  }

  set(px: number, py: number, color: number, weight = 1) {
    px = Math.round(px);
    py = Math.round(py);
    if (px < 0 || py < 0 || px >= this.pw || py >= this.ph) return;
    const i = (py >> 2) * this.w + (px >> 1);
    this.mask[i] |= DOTS[py & 3][px & 1];
    if (weight >= this.weight[i]) {
      this.weight[i] = weight;
      this.color[i] = color;
    }
  }

  line(x0: number, y0: number, x1: number, y1: number, color: number, weight = 1, step = 1) {
    const len = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let i = 0; i <= len; i += step) this.set(x0 + ((x1 - x0) * i) / len, y0 + ((y1 - y0) * i) / len, color, weight);
  }

  arc(cx: number, cy: number, r: number, a0: number, a1: number, color: number, weight = 1, gap = 1) {
    const steps = Math.max(12, Math.ceil(Math.abs(a1 - a0) * r * 1.2));
    for (let i = 0; i <= steps; i += gap) {
      const a = a0 + ((a1 - a0) * i) / steps;
      this.set(cx + r * Math.cos(a), cy + r * Math.sin(a), color, weight);
    }
  }

  blit(screen: Screen, x: number, y: number) {
    for (let j = 0; j < this.h; j++)
      for (let i = 0; i < this.w; i++) {
        const k = j * this.w + i;
        if (this.mask[k]) screen.put(x + i, y + j, String.fromCharCode(0x2800 + this.mask[k]), this.color[k]);
      }
  }
}
