import { asRecord } from "#src/json-record";

/** Joins ACP tool content blocks, then returns the new suffix and full output to remember. */
export function acpToolOutput(
  previous: string,
  content: unknown,
): { full: string; text?: string } | undefined {
  if (!Array.isArray(content)) return undefined;
  const textItems = content
    .map((value) => {
      const item = asRecord(value);
      const block = asRecord(item?.content);
      return item?.type === "content" && block?.type === "text" && typeof block.text === "string"
        ? block.text
        : undefined;
    })
    .filter((text): text is string => text !== undefined);
  if (!textItems.length) return undefined;
  const full = textItems.join("\n");
  if (full === previous) return { full };
  const text = full.startsWith(previous) ? full.slice(previous.length) || undefined : full;
  return { full, ...(text ? { text } : {}) };
}
