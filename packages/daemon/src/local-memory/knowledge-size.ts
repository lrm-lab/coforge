import { lstat, opendir } from "node:fs/promises";
import { join } from "node:path";
import { readMemoryFile, safeMemoryDirectory } from "./memory-files";
import type { MemoryMeasurement } from "#src/system-cleaner/system-cleaner-measure";

const INSPECTION_LIMIT = 512;
const PREFIX_BYTES = 16_384;

export async function measureKnowledgeSize(root: string): Promise<MemoryMeasurement> {
  try {
    const directory = await safeMemoryDirectory(root, "notes/knowledge");
    const files = await opendir(directory);
    let bytes = 0;
    let inspected = 0;
    let incomplete = false;
    let batch: string[] = [];
    const measureBatch = async () => {
      const sizes = await Promise.all(
        batch.map(async (name) => {
          const path = `notes/knowledge/${name}`;
          const info = await lstat(join(root, path));
          if (!info.isFile()) return 0;
          const text = await readMemoryFile(root, path, PREFIX_BYTES);
          const header = JSON.parse(/^---\n([^\n]+)\n---\n/.exec(text ?? "")?.[1] ?? "null");
          if (
            !header ||
            header.format !== "coforge-memory-v1" ||
            header.key !== name.slice(0, -3) ||
            !["active", "archived"].includes(header.status)
          )
            throw new Error("memory_invalid_file");
          return header.status === "active" ? info.size : 0;
        }),
      );
      bytes += sizes.reduce((sum, size) => sum + size, 0);
      batch = [];
    };
    for await (const file of files) {
      if (++inspected > INSPECTION_LIMIT) {
        incomplete = true;
        break;
      }
      if (!file.isFile() || !/^[a-z0-9][a-z0-9_-]*\.md$/.test(file.name)) continue;
      batch.push(file.name);
      if (batch.length === 8) await measureBatch();
    }
    if (batch.length) await measureBatch();
    return { kind: "measured", bytes, ...(incomplete ? { incomplete: true } : {}) };
  } catch (error) {
    return (error as { code?: string }).code === "ENOENT"
      ? { kind: "measured", bytes: 0 }
      : { kind: "not_established", reason: "read_failed" };
  }
}
