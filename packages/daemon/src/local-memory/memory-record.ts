import type { LocalMemoryEntry } from "@lrm/coforge-sdk/agent";
import { decodeLocalMemoryCommand } from "@lrm/coforge-sdk/agent";

export function memoryRevision(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

export function encodeMemoryRecord(entry: Omit<LocalMemoryEntry, "path" | "revision">): string {
  const { content, ...metadata } = entry;
  return `---\n${JSON.stringify({ format: "coforge-memory-v1", ...metadata })}\n---\n${content}\n`;
}

function memoryRecordHeader(text: string) {
  const match = /^---\n([^\n]+)\n---\n/.exec(text);
  if (!match) return undefined;
  try {
    const metadata = JSON.parse(match[1]!);
    if (
      metadata.format !== "coforge-memory-v1" ||
      !["active", "archived"].includes(metadata.status) ||
      typeof metadata.updatedAt !== "string" ||
      !Number.isFinite(Date.parse(metadata.updatedAt))
    )
      return undefined;
    return { metadata, contentOffset: match[0].length };
  } catch {
    return undefined;
  }
}

export function memoryRecordSummary(
  text: string,
): (Pick<LocalMemoryEntry, "key" | "status"> & { timestamp: number }) | undefined {
  const header = memoryRecordHeader(text);
  if (!header || typeof header.metadata.key !== "string") return undefined;
  return {
    key: header.metadata.key,
    status: header.metadata.status,
    timestamp: Date.parse(header.metadata.updatedAt),
  };
}

export function decodeMemoryRecord(text: string, path: string): LocalMemoryEntry | undefined {
  const header = memoryRecordHeader(text);
  if (!header) return undefined;
  const { metadata, contentOffset } = header;
  try {
    const command = decodeLocalMemoryCommand({
      operation: "save",
      key: metadata.key,
      revision: "new",
      title: metadata.title,
      kind: metadata.kind,
      applicability: metadata.applicability,
      source: metadata.source,
      content: text.slice(contentOffset).trimEnd(),
    });
    if (command.operation !== "save") return undefined;
    return {
      key: command.key,
      title: command.title,
      kind: command.kind,
      applicability: command.applicability,
      source: command.source,
      content: command.content,
      updatedAt: metadata.updatedAt,
      status: metadata.status,
      path,
      revision: memoryRevision(text),
    };
  } catch {
    return undefined;
  }
}

function normalized(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase();
}

export function memorySearchScore(
  text: string,
  query: string,
): { score: number; position: number } {
  const content = normalized(text);
  const wanted = normalized(query).trim();
  const terms = new Set(wanted.match(/[\p{L}\p{N}_.:/-]+/gu) ?? []);
  for (const word of [...terms]) {
    if (/[\p{Script=Han}]/u.test(word))
      for (let index = 0; index < word.length - 1; index++) terms.add(word.slice(index, index + 2));
  }
  let score = content.includes(wanted) ? 10 : 0;
  let position = content.indexOf(wanted);
  for (const term of terms) {
    const found = content.indexOf(term);
    if (found < 0) continue;
    score += term.length > 2 ? 3 : 1;
    if (position < 0 || found < position) position = found;
  }
  return { score, position: Math.max(0, position) };
}
