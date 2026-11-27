import {
  TERMINAL_MAX_CHUNK_BYTES,
  TERMINAL_MAX_HISTORY_BYTES,
} from "@lrm/coforge-sdk/internal/computer-terminal-wire";

type OutputChunk = { outputSeq: number; bytes: Uint8Array };

export class ComputerTerminalOutput {
  #nextOutputSeq = 1;
  #history: Uint8Array | undefined = new Uint8Array();
  #used = 0;

  get nextOutputSeq(): number {
    return this.#nextOutputSeq;
  }

  get historyUnavailable(): boolean {
    return this.#history === undefined;
  }

  get snapshotSize(): { frames: number; bytes: number } {
    const chunks = this.#nextOutputSeq - 1;
    return { frames: Math.max(1, chunks), bytes: this.#used - 2 * chunks };
  }

  resized(): void {
    if (this.#nextOutputSeq > 1) this.#history = undefined;
  }

  *append(bytes: Uint8Array): Iterable<OutputChunk> {
    for (let offset = 0; offset < bytes.byteLength; offset += TERMINAL_MAX_CHUNK_BYTES) {
      const chunk = bytes.slice(offset, offset + TERMINAL_MAX_CHUNK_BYTES);
      this.#retain(chunk);
      yield { outputSeq: this.#nextOutputSeq++, bytes: chunk };
    }
  }

  *snapshot(): Iterable<OutputChunk & { final: boolean }> {
    const history = this.#history;
    if (!history) return;
    if (this.#used === 0) {
      yield { outputSeq: 0, bytes: new Uint8Array(), final: true };
      return;
    }
    let outputSeq = 1;
    let cursor = 0;
    while (cursor < this.#used) {
      const length = history[cursor]! * 256 + history[cursor + 1]!;
      const start = cursor + 2;
      cursor = start + length;
      yield {
        outputSeq: outputSeq++,
        bytes: history.subarray(start, cursor),
        final: cursor === this.#used,
      };
    }
  }

  #retain(bytes: Uint8Array): void {
    if (!this.#history) return;
    const required = this.#used + 2 + bytes.byteLength;
    if (required > TERMINAL_MAX_HISTORY_BYTES) {
      this.#history = undefined;
      return;
    }
    if (this.#history.byteLength < required) {
      const capacity = Math.min(
        TERMINAL_MAX_HISTORY_BYTES,
        Math.max(4096, required, this.#history.byteLength * 2),
      );
      const expanded = new Uint8Array(capacity);
      expanded.set(this.#history);
      this.#history = expanded;
    }
    this.#history[this.#used] = bytes.byteLength >>> 8;
    this.#history[this.#used + 1] = bytes.byteLength & 255;
    this.#history.set(bytes, this.#used + 2);
    this.#used = required;
  }
}
