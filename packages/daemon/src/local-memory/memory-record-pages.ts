import type { LocalMemoryEntry } from "@lrm/coforge-sdk/agent";
import { MEMORY_FILE_BYTES, readMemoryFile } from "./memory-files";
import { memoryRecordSummary } from "./memory-record";

const historyOrders = new Map<string, { files: string[]; ordered: string[]; expires: number }>();

export async function readMemoryRecordSummary(root: string, path: string) {
  for (const bytes of [1024, 12_288, 65_536, MEMORY_FILE_BYTES]) {
    const prefix = await readMemoryFile(root, path, bytes).catch(() => undefined);
    if (!prefix?.startsWith("---\n")) return undefined;
    if (prefix.includes("\n---\n", 4)) return memoryRecordSummary(prefix);
    if (Buffer.byteLength(prefix) < bytes - 3) return undefined;
  }
  return undefined;
}

export async function orderMemoryHistory(root: string, key: string, files: string[]) {
  const id = JSON.stringify([root, key]);
  const cached = historyOrders.get(id);
  if (
    cached &&
    cached.expires > Date.now() &&
    files.length === cached.files.length &&
    files.every((file, index) => file === cached.files[index])
  )
    return cached.ordered;

  const revisions: { file: string; timestamp: number }[] = [];
  for (let index = 0; index < files.length; index += 8) {
    const batch = await Promise.all(
      files.slice(index, index + 8).map(async (file) => {
        const summary = await readMemoryRecordSummary(root, `notes/history/${key}/${file}`);
        return summary?.key === key ? { file, timestamp: summary.timestamp } : undefined;
      }),
    );
    for (const revision of batch) if (revision) revisions.push(revision);
  }
  const ordered = revisions
    .sort((a, b) => b.timestamp - a.timestamp || a.file.localeCompare(b.file))
    .map(({ file }) => file);
  if (files.length <= 16_384) {
    if (historyOrders.size === 8 && !historyOrders.has(id))
      historyOrders.delete(historyOrders.keys().next().value!);
    historyOrders.set(id, { files, ordered, expires: Date.now() + 30_000 });
  }
  return ordered;
}

export function memoryListPreview(entry: LocalMemoryEntry, maxBytes: number): LocalMemoryEntry {
  const preview = {
    ...entry,
    updatedAt: new Date(entry.updatedAt).toISOString(),
    content: entry.content.slice(0, 600),
    source: entry.source.slice(0, 200),
    applicability: entry.applicability.slice(0, 150),
  };
  while (Buffer.byteLength(JSON.stringify(preview)) > maxBytes) {
    preview.content = preview.content.slice(0, Math.floor(preview.content.length / 2));
    preview.source = preview.source.slice(0, Math.floor(preview.source.length / 2));
    preview.applicability = preview.applicability.slice(
      0,
      Math.floor(preview.applicability.length / 2),
    );
  }
  return preview;
}
