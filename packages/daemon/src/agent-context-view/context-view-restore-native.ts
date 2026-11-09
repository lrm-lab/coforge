import type {
  RecordValue,
  RestoreRequest,
  ContextViewRestoreResult,
  RestoredContextMessage,
} from "./context-view-restore";
import {
  buildView,
  claudeViewParts,
  hasHashMismatch,
  hasMessageId,
  hasNestedIdentityConflict,
  isRecord,
  message,
  parseToolInput,
  providerPayload,
  sessionMatches,
} from "./context-view-restore";
import { restoreClaudeSession } from "./claude-session-restore";

export function restoreClaude(
  records: RecordValue[],
  request: RestoreRequest,
): ContextViewRestoreResult {
  const raw = Buffer.from(
    records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : ""),
  );
  const native = restoreClaudeSession({
    buffer: raw,
    offset: raw.length,
    sessionId: request.sessionId,
    messageId: request.messageId,
  });
  if (!native.ok) return { ok: false, failure: native.failure };
  return {
    ok: true,
    view: {
      runtime: request.runtime,
      sessionId: request.sessionId,
      messageId: request.messageId,
      messages: native.messages.map((entry) => ({
        role:
          entry.role === "assistant" ? "assistant" : entry.role === "system" ? "system" : "user",
        parts: claudeViewParts(entry.content),
      })),
      source: { kind: "native", format: "claude-jsonl" },
      verification: native.digestMatch === true ? "verified" : undefined,
      redactions: native.redactions,
      responseFound: native.responseFound,
      digestMatch: native.digestMatch,
      system: native.system,
      tools: native.tools,
      compaction: native.compaction,
      usage: native.usage,
      tokens: native.tokens,
      trigger: native.trigger,
      model: native.model ?? null,
      requestAt: native.requestAt ?? null,
      unrestoredMessages: native.unresolvedMessages,
    },
  };
}
export function restoreCodex(
  records: RecordValue[],
  request: RestoreRequest,
): ContextViewRestoreResult {
  const messages: RestoredContextMessage[] = [];
  const effective: RecordValue[] = [];
  let compacted = false;
  let model: string | null = null;
  let requestAt: string | null = null;
  let sawAdditionalTools = false;
  const codexTools: Array<{ name: string; description: string; inputSchema: unknown }> = [];
  for (const original of records) {
    const record = providerPayload(original);
    if (record.type === "turn_context") {
      const context = isRecord(record.payload) ? record.payload : record;
      if (typeof context.model === "string") model = context.model;
      if (typeof record.timestamp === "string") requestAt = record.timestamp;
    }
    if (record.type === "compacted") {
      compacted = true;
      const replacement = record.replacement_history;
      if (replacement !== undefined) {
        if (!Array.isArray(replacement) || !replacement.every(isRecord))
          return { ok: false, failure: "read_failed" };
        effective.length = 0;
        effective.push(...replacement);
      }
      continue;
    }
    effective.push(record);
  }
  let sawTarget = false;
  let responseFound = false;
  let trigger: { toolUseId: string } | undefined;
  const toolCalls = new Map<string, { name?: string; arguments?: unknown; target: boolean }>();
  const targetIndex = effective.findIndex((record) => hasMessageId(record, request.messageId));
  const isUserBoundary = (record: RecordValue): boolean =>
    record.type === "user_message" ||
    (record.type === "response_item" &&
      ((isRecord(record.item) && record.item.type === "message" && record.item.role === "user") ||
        (isRecord(record.payload) &&
          record.payload.type === "message" &&
          record.payload.role === "user")));
  const nextUserIndex =
    targetIndex < 0
      ? -1
      : effective.findIndex((record, index) => index > targetIndex && isUserBoundary(record));
  const boundary = nextUserIndex >= 0 ? nextUserIndex : effective.length;
  for (const [index, record] of effective.slice(0, boundary).entries()) {
    if (hasNestedIdentityConflict(record)) return { ok: false, failure: "context_mismatch" };
    if (!sessionMatches(record, request.sessionId))
      return { ok: false, failure: "context_mismatch" };
    if (hasHashMismatch(record)) return { ok: false, failure: "context_mismatch" };
    if (
      record.type === "event_msg" &&
      (record.payload === "thread_rolled_back" ||
        (isRecord(record.payload) && record.payload.type === "thread_rolled_back"))
    )
      return { ok: false, failure: "context_mismatch" };
    if (record.type === "thread_rolled_back" || record.type === "rollback")
      return { ok: false, failure: "context_mismatch" };
    const responseItem =
      record.type === "response_item"
        ? isRecord(record.item)
          ? record.item
          : isRecord(record.payload)
            ? record.payload
            : undefined
        : undefined;
    if (responseItem) {
      if (responseItem.type === "additional_tools") {
        sawAdditionalTools = true;
        if (Array.isArray(responseItem.tools)) {
          for (const tool of responseItem.tools) {
            if (!isRecord(tool) || typeof tool.name !== "string") continue;
            codexTools.push({
              name: tool.name,
              description: typeof tool.description === "string" ? tool.description : "",
              inputSchema: tool.inputSchema ?? tool.input_schema ?? null,
            });
          }
        }
        if (hasMessageId(record, request.messageId)) sawTarget = true;
        continue;
      }
      if (responseItem.type === "message") {
        messages.push(
          message(responseItem.role === "assistant" ? "assistant" : "user", responseItem.content),
        );
        if (targetIndex >= 0 && index > targetIndex && responseItem.role === "assistant")
          responseFound = true;
      } else if (responseItem.type === "function_call") {
        const toolUseId = responseItem.call_id ?? responseItem.id;
        messages.push(
          message("assistant", [
            {
              type: "tool_use",
              name: responseItem.name,
              id: toolUseId,
              input: parseToolInput(responseItem.arguments),
            },
          ]),
        );
        if (typeof toolUseId === "string") {
          toolCalls.set(toolUseId, {
            name: typeof responseItem.name === "string" ? responseItem.name : undefined,
            arguments: responseItem.arguments,
            target: hasMessageId(record, request.messageId),
          });
          const command = `${typeof responseItem.name === "string" ? responseItem.name : ""} ${typeof responseItem.arguments === "string" ? responseItem.arguments : JSON.stringify(responseItem.arguments ?? "")}`;
          if (/\b(?:raft|slock)\s+(?:message\s+send|task\s+reply)\b/.test(command))
            trigger = { toolUseId };
        }
        if (targetIndex >= 0 && index > targetIndex) responseFound = true;
      } else if (responseItem.type === "function_call_output") {
        const toolUseId = responseItem.call_id ?? responseItem.id;
        messages.push(
          message("tool", [
            { type: "tool_result", tool_use_id: toolUseId, content: responseItem.output ?? "" },
          ]),
        );
        if (targetIndex >= 0 && index > targetIndex) responseFound = true;
        if (typeof toolUseId === "string") {
          const call = toolCalls.get(toolUseId);
          if (
            call?.target ||
            (typeof responseItem.output === "string" &&
              new RegExp(
                `Message ID: ${request.messageId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_-])`,
              ).test(responseItem.output))
          )
            trigger = { toolUseId };
        }
      } else if (responseItem.type === "reasoning") {
        messages.push(
          message("assistant", [
            { type: "thinking", thinking: responseItem.summary ?? responseItem.content ?? "" },
          ]),
        );
      } else {
        messages.push(message("tool", responseItem.content ?? responseItem));
      }
    } else if (record.type === "user_message") messages.push(message("user", record.message));
    if (hasMessageId(record, request.messageId)) sawTarget = true;
    if (record.type === "unknown_future" || record.type === "unsupported_future")
      return { ok: false, failure: "newer_session_format" };
  }
  if (!messages.length) return { ok: false, failure: "not_found" };
  if (!sawAdditionalTools) return { ok: false, failure: "unsupported_runtime" };
  const built = buildView(
    request,
    messages,
    compacted ? "codex-rollout-compacted" : "codex-rollout",
    sawTarget ? "verified" : "count_matched",
  );
  if (built.ok) {
    built.view.responseFound = responseFound;
    if (trigger) built.view.trigger = trigger;
    built.view.model = model;
    built.view.requestAt = requestAt;
    built.view.tools = codexTools;
  }
  return built;
}
