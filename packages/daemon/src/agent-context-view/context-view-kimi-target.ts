import type { RecordValue } from "./context-view-restore";
import { isRecord, parseToolInput, recordEnd } from "./context-view-restore";

function reportsMessage(value: unknown, messageId: string): boolean {
  const escaped = messageId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`Message ID:\\s*${escaped}(?![A-Za-z0-9_-])`).test(
    typeof value === "string" ? value : JSON.stringify(value ?? ""),
  );
}

export function kimiSendRecordIndex(
  records: RecordValue[],
  messageId: string,
  indexOffset: number,
): number | undefined {
  const calls = new Map<string, { command: string; sourceIndex: number }>();
  for (const [sourceIndex, record] of records.entries()) {
    if (record.type !== "context.append_loop_event" || !isRecord(record.event)) continue;
    const event = record.event;
    if (event.type !== "tool.call") continue;
    const id =
      typeof event.toolCallId === "string"
        ? event.toolCallId
        : typeof event.id === "string"
          ? event.id
          : undefined;
    if (!id) continue;
    const args = parseToolInput(event.arguments ?? event.args);
    calls.set(id, {
      command:
        isRecord(args) && typeof args.command === "string"
          ? args.command
          : typeof event.command === "string"
            ? event.command
            : "",
      sourceIndex,
    });
  }
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    if (record.type !== "context.append_loop_event" || !isRecord(record.event)) continue;
    const event = record.event;
    if (event.type !== "tool.result" || typeof event.toolCallId !== "string") continue;
    if (!reportsMessage(event.output, messageId)) continue;
    const call = calls.get(event.toolCallId);
    if (!call) continue;
    if (
      /\b(?:raft|slock)\s+(?:message\s+send|task\s+reply)\b/.test(call.command) ||
      (recordEnd(records[call.sourceIndex]!) ?? Number.MAX_SAFE_INTEGER) <= indexOffset
    )
      return index;
  }
  return undefined;
}
