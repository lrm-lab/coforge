/**
 * Splits decoded provider output into `\n`-terminated lines.
 *
 * Each chunk is scanned once and the unterminated tail is kept as pieces joined only when its
 * newline arrives, so a record spread over many chunks costs time linear in its size. Appending
 * every chunk to one string and rescanning it from the start made a 32 MiB record take seconds.
 */
export class LineBuffer {
  #pieces: string[] = [];

  /** Feeds `text` and calls `onLine` for each completed line, without its one trailing `\r`. */
  push(text: string, onLine: (line: string) => void): void {
    let start = 0;
    let newline = text.indexOf("\n");
    while (newline >= 0) {
      let line = text.slice(start, newline);
      if (this.#pieces.length > 0) {
        this.#pieces.push(line);
        line = this.#pieces.join("");
        this.#pieces = [];
      }
      onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
      start = newline + 1;
      newline = text.indexOf("\n", start);
    }
    if (start < text.length) this.#pieces.push(start === 0 ? text : text.slice(start));
  }

  /** The text after the last newline so far, as fed. */
  rest(): string {
    return this.#pieces.join("");
  }
}
