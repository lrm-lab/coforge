import { lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readMemoryFile, safeMemoryDirectory } from "./memory-files";

export class MemoryFileIndex {
  readonly #files = new Map<string, { signature: string; text: string }>();
  #bytes = 0;
  constructor(private readonly root: string) {}

  async read(path: string): Promise<string | undefined> {
    try {
      await safeMemoryDirectory(this.root, dirname(path));
      const info = await lstat(join(this.root, path), { bigint: true });
      if (!info.isFile()) throw new Error("memory_unsafe_path");
      const signature = `${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
      const cached = this.#files.get(path);
      if (cached?.signature === signature) return cached.text;
      const text = await readMemoryFile(this.root, path);
      if (cached) {
        this.#bytes -= Buffer.byteLength(cached.text);
        this.#files.delete(path);
      }
      if (text !== undefined) {
        while (this.#files.size >= 128 || this.#bytes + Buffer.byteLength(text) > 4 * 1024 * 1024) {
          const oldest = this.#files.keys().next().value;
          if (oldest === undefined) break;
          this.#bytes -= Buffer.byteLength(this.#files.get(oldest)!.text);
          this.#files.delete(oldest);
        }
        this.#files.set(path, { signature, text });
        this.#bytes += Buffer.byteLength(text);
      }
      return text;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
}
