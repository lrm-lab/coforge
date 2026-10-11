import type { AgentRuntimeEvent } from "#src/code-agent/contract";
import { asRecord, eventTime } from "#src/code-agent/json-record";

/**
 * The tool starts one Codex `item/started` notification reports: a command execution, or one
 * write/edit per file a file change touches. Any other item reports nothing.
 */
export function codexItemStartedEvents(
  record: Readonly<Record<string, unknown>>,
): AgentRuntimeEvent[] {
  const item = asRecord(asRecord(record.params)?.item);
  if (item?.type === "commandExecution" && typeof item.id === "string") {
    const command = typeof item.command === "string" ? item.command : "command";
    // Reported as a raw "bash" tool-start, same as every other provider, so the
    // daemon core's `toolActivity` resolves a `coforge …` command to its hidden
    // tool (e.g. `send_message`) instead of showing it as a generic shell command.
    return [
      {
        type: "tool-start",
        id: item.id,
        name: "bash",
        input: { command },
        occurredAt: eventTime(record),
      },
    ];
  }
  if (item?.type === "fileChange") {
    const itemId = typeof item.id === "string" ? item.id : "file-change";
    return fileChanges(item).map((change, index) => ({
      type: "tool-start",
      id: `${itemId}:${index}`,
      name: change.kind === "add" ? "write_file" : "edit_file",
      input: { file_path: change.path },
      occurredAt: eventTime(record),
    }));
  }
  return [];
}

function fileChanges(
  item: Readonly<Record<string, unknown>>,
): Array<{ kind: string; path: string }> {
  const changes = Array.isArray(item.changes) ? item.changes : [item];
  return changes.flatMap((value) => {
    const change = asRecord(value);
    if (!change || typeof change.path !== "string") return [];
    return [
      {
        kind: typeof change.kind === "string" ? change.kind : "edit",
        path: change.path,
      },
    ];
  });
}
