/**
 * The smallest terminal screen buffer Droid's `/limits` panel needs: a fixed grid that applies
 * cursor movement, erase and scroll operations and yields plain text lines. It is deliberately
 * not a terminal emulator — SGR colors, mouse and keyboard protocols, insert/delete char and
 * most mode sets are ignored because the panel never depends on them.
 */
export interface VtScreenSize {
  readonly cols: number;
  readonly rows: number;
}

type Cell = { ch: string; wide: boolean };

const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x2e80, 0xa4cf], // CJK Radicals .. Yi
  [0xac00, 0xd7a3], // Hangul Syllables
  [0xf900, 0xfaff], // CJK Compatibility Ideographs
  [0xfe30, 0xfe6f], // CJK Compatibility Forms
  [0xff00, 0xff60], // Fullwidth Forms
  [0x1f300, 0x1faff], // emoji and pictographs
  [0x20000, 0x3fffd], // CJK Ext B and beyond
];

function charWidth(codePoint: number): number {
  if (codePoint === 0) return 0;
  if (codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0;
  if (codePoint >= 0x0300 && codePoint <= 0x036f) return 0; // combining marks
  if (codePoint >= 0xfe00 && codePoint <= 0xfe0f) return 0; // variation selectors
  if (WIDE_RANGES.some(([lo, hi]) => codePoint >= lo && codePoint <= hi)) return 2;
  return 1;
}

export class VtScreen {
  readonly #cols: number;
  readonly #rows: number;
  readonly #cells: Cell[][];
  #x = 0;
  #y = 0;
  #savedX = 0;
  #savedY = 0;
  #top = 0;
  #bottom: number;
  #state: "ground" | "esc" | "esc-dcs" | "csi" | "osc" | "osc-tail" | "dcs" | "charset" = "ground";
  #csiParams = "";

  constructor(size: VtScreenSize) {
    this.#cols = size.cols;
    this.#rows = size.rows;
    this.#bottom = size.rows - 1;
    this.#cells = Array.from({ length: size.rows }, () =>
      Array.from({ length: size.cols }, () => ({ ch: " ", wide: false })),
    );
  }

  /** Feed one chunk of raw terminal output; partial escape sequences may span chunks. */
  write(text: string): void {
    for (const ch of text) this.#step(ch);
  }

  /** The visible screen as text lines, trailing blanks trimmed per line. */
  lines(): string[] {
    return this.#cells.map((row) => {
      let line = "";
      for (const cell of row) {
        if (cell.wide) continue; // continuation cell of a wide character
        line += cell.ch;
      }
      return line.replace(/\s+$/u, "");
    });
  }

  #step(ch: string): void {
    switch (this.#state) {
      case "osc":
        if (ch === "\x07") this.#state = "ground";
        else if (ch === "\x1b") this.#state = "osc-tail";
        return;
      case "osc-tail":
        if (ch === "\\") this.#state = "ground";
        return;
      case "dcs":
        if (ch === "\x1b") this.#state = "esc-dcs";
        return;
      case "esc-dcs":
        this.#state = "ground";
        if (ch === "\\") return; // ST ends the string sequence
        this.#esc(ch);
        return;
      case "charset":
        this.#state = "ground";
        return; // charset selection never changes cell text for this panel
      case "esc":
        this.#state = "ground";
        this.#esc(ch);
        return;
      case "csi":
        if (ch === "\x1b") {
          this.#state = "esc";
          this.#csiParams = "";
          return;
        }
        if (ch >= "@" && ch <= "~") {
          this.#csi(this.#csiParams, ch);
          this.#state = "ground";
          this.#csiParams = "";
        } else {
          this.#csiParams += ch;
        }
        return;
      default:
        break;
    }
    if (ch === "\x1b") {
      this.#state = "esc";
      return;
    }
    this.#print(ch);
  }

  #esc(ch: string): void {
    switch (ch) {
      case "7":
        this.#savedX = this.#x;
        this.#savedY = this.#y;
        return;
      case "8":
        this.#x = Math.min(this.#savedX, this.#cols - 1);
        this.#y = Math.min(this.#savedY, this.#rows - 1);
        return;
      case "D": // IND
        this.#lineFeed();
        return;
      case "E": // NEL
        this.#x = 0;
        this.#lineFeed();
        return;
      case "M": // RI
        if (this.#y === this.#top) this.#scrollDown();
        else this.#y = Math.max(this.#top, this.#y - 1);
        return;
      case "c": // RIS
        this.#clearAll();
        this.#x = 0;
        this.#y = 0;
        this.#top = 0;
        this.#bottom = this.#rows - 1;
        return;
      case "]":
        this.#state = "osc";
        return;
      case "P":
      case "X":
      case "^":
      case "_":
        this.#state = "dcs"; // string sequences end at ST, handled via esc→\\ below
        return;
      case "(":
      case ")":
        this.#state = "charset";
        return;
      case "[":
        this.#state = "csi";
        return;
      default:
        return; // two-byte escapes we do not model
    }
  }

  #csi(params: string, final: string): void {
    // Private modes (?…) carry no cell data except the alternate-screen switches.
    if (params.startsWith("?")) {
      if (final === "h" || final === "l") this.#privateMode(params, final === "h");
      return;
    }
    const nums = params.split(";").map((p) => {
      const n = Number.parseInt(p, 10);
      return Number.isFinite(n) ? n : 0;
    });
    const n = (i: number, fallback: number) => (nums[i]! > 0 ? nums[i]! : fallback);
    switch (final) {
      case "H":
      case "f":
        this.#y = Math.min(Math.max(n(0, 1) - 1, 0), this.#rows - 1);
        this.#x = Math.min(Math.max(n(1, 1) - 1, 0), this.#cols - 1);
        return;
      case "A":
        this.#y = Math.max(this.#top, this.#y - n(0, 1));
        return;
      case "B":
        this.#y = Math.min(this.#bottom, this.#y + n(0, 1));
        return;
      case "C":
        this.#x = Math.min(this.#cols - 1, this.#x + n(0, 1));
        return;
      case "D":
        this.#x = Math.max(0, this.#x - n(0, 1));
        return;
      case "E":
        this.#y = Math.min(this.#bottom, this.#y + n(0, 1));
        this.#x = 0;
        return;
      case "F":
        this.#y = Math.max(this.#top, this.#y - n(0, 1));
        this.#x = 0;
        return;
      case "G":
      case "`":
        this.#x = Math.min(Math.max(n(0, 1) - 1, 0), this.#cols - 1);
        return;
      case "d":
        this.#y = Math.min(Math.max(n(0, 1) - 1, 0), this.#rows - 1);
        return;
      case "J":
        this.#eraseDisplay(nums[0] ?? 0);
        return;
      case "K":
        this.#eraseLine(nums[0] ?? 0);
        return;
      case "X":
        this.#eraseCells(n(0, 1));
        return;
      case "s":
        this.#savedX = this.#x;
        this.#savedY = this.#y;
        return;
      case "u":
        this.#x = Math.min(this.#savedX, this.#cols - 1);
        this.#y = Math.min(this.#savedY, this.#rows - 1);
        return;
      case "r": {
        const top = Math.max((nums[0] || 1) - 1, 0);
        const bottom = Math.min((nums[1] || this.#rows) - 1, this.#rows - 1);
        if (top < bottom) {
          this.#top = top;
          this.#bottom = bottom;
        }
        this.#x = 0;
        this.#y = 0;
        return;
      }
      default:
        return;
    }
  }

  /** Alternate-screen switches (1047/1049) repaint from a blank grid on entry and exit. */
  #privateMode(params: string, on: boolean): void {
    const modes = params.split(";");
    if (modes.includes("?1049") || modes.includes("?1047")) {
      if (on) {
        this.#clearAll();
        this.#x = 0;
        this.#y = 0;
      }
    }
  }

  #eraseDisplay(mode: number): void {
    if (mode === 2 || mode === 3) {
      this.#clearAll();
      return;
    }
    if (mode === 0) {
      this.#eraseCells(this.#cols - this.#x);
      for (let y = this.#y + 1; y < this.#rows; y += 1) this.#clearRow(y);
    } else if (mode === 1) {
      for (let y = 0; y < this.#y; y += 1) this.#clearRow(y);
      for (let x = 0; x <= this.#x; x += 1) this.#put(x, this.#y, " ", false);
    }
  }

  #eraseLine(mode: number): void {
    if (mode === 0) {
      for (let x = this.#x; x < this.#cols; x += 1) this.#put(x, this.#y, " ", false);
    } else if (mode === 1) {
      for (let x = 0; x <= this.#x; x += 1) this.#put(x, this.#y, " ", false);
    } else if (mode === 2) {
      this.#clearRow(this.#y);
    }
  }

  #eraseCells(count: number): void {
    for (let i = 0; i < count && this.#x + i < this.#cols; i += 1)
      this.#put(this.#x + i, this.#y, " ", false);
  }

  #clearRow(y: number): void {
    for (let x = 0; x < this.#cols; x += 1) this.#put(x, y, " ", false);
  }

  #clearAll(): void {
    for (let y = 0; y < this.#rows; y += 1) this.#clearRow(y);
  }

  #lineFeed(): void {
    if (this.#y === this.#bottom) this.#scrollUp();
    else this.#y = Math.min(this.#rows - 1, this.#y + 1);
  }

  #scrollUp(): void {
    const removed = this.#cells.splice(this.#top, 1)[0]!;
    for (const cell of removed) {
      cell.ch = " ";
      cell.wide = false;
    }
    this.#cells.splice(this.#bottom, 0, removed);
  }

  #scrollDown(): void {
    const removed = this.#cells.splice(this.#bottom, 1)[0]!;
    for (const cell of removed) {
      cell.ch = " ";
      cell.wide = false;
    }
    this.#cells.splice(this.#top, 0, removed);
  }

  #print(ch: string): void {
    if (ch === "\r") {
      this.#x = 0;
      return;
    }
    if (ch === "\n") {
      this.#lineFeed();
      return;
    }
    if (ch === "\b") {
      this.#x = Math.max(0, this.#x - 1);
      return;
    }
    if (ch === "\t") {
      this.#x = Math.min(this.#cols - 1, (Math.floor(this.#x / 8) + 1) * 8);
      return;
    }
    const codePoint = ch.codePointAt(0) ?? 0;
    const width = charWidth(codePoint);
    if (width === 0) return;
    if (this.#x >= this.#cols) {
      this.#x = 0;
      this.#lineFeed();
    }
    this.#put(this.#x, this.#y, ch, width === 2);
    if (width === 2) {
      if (this.#x + 1 < this.#cols) this.#put(this.#x + 1, this.#y, "", true);
      this.#x = Math.min(this.#cols, this.#x + 2);
    } else {
      this.#x += 1;
    }
  }

  #put(x: number, y: number, ch: string, continuation: boolean): void {
    if (x < 0 || x >= this.#cols || y < 0 || y >= this.#rows) return;
    const cell = this.#cells[y]![x]!;
    if (continuation) {
      cell.ch = "";
      cell.wide = true;
      return;
    }
    // Overwriting half of a wide char leaves its other half orphaned; blank it.
    if (cell.wide) {
      if (x > 0) this.#put(x - 1, y, " ", false);
    } else if (x + 1 < this.#cols && this.#cells[y]![x + 1]!.wide) {
      this.#put(x + 1, y, " ", false);
    }
    cell.ch = ch;
    cell.wide = false;
  }
}
