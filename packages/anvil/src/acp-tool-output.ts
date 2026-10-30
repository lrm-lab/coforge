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

/** Whether a `tool_call_update` status ends the call. ACP's terminal statuses are `completed`,
 * `failed` and `stopped` (a cancelled call); `cancelled` costs nothing to accept and is what some
 * providers spell instead. A call whose end is missed reads open forever, and stalled recovery
 * never restarts over it. */
export function acpToolUpdateEnded(status: unknown): boolean {
  return (
    status === "completed" || status === "failed" || status === "stopped" || status === "cancelled"
  );
}
