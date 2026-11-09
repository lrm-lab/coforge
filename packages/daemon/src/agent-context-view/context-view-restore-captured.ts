import type {
  RecordValue,
  RestoreRequest,
  ContextViewRestoreResult,
  RestoredContextMessage,
  RestoredContextView,
} from "./context-view-restore";
import {
  claudeViewParts,
  hasHashMismatch,
  hasMessageId,
  hasNestedIdentityConflict,
  isRecord,
  message,
  parseToolInput,
  providerPayload,
  sessionMatches,
  textParts,
  buildView,
} from "./context-view-restore";

export function restoreKimi(
  records: RecordValue[],
  request: RestoreRequest,
): ContextViewRestoreResult {
  if (records.length > 10_000) return { ok: false, failure: "too_large" };
  const messages: RestoredContextMessage[] = [];
  const toolNames = new Map<string, string>();
  const toolCommands = new Map<string, string>();
  let sawTarget = false;
  let responseFound = false;
  let trigger: { toolUseId: string } | undefined;
  let compaction: RestoredContextView["compaction"] = { happened: false };
  let model: string | null = null;
  let requestAt: string | null = null;
  let tokens: RestoredContextView["tokens"] = { input: null, cacheRead: null, total: null };
  let lastSequence: number | undefined;
  let requestCount = 0;
  let responseCount = 0;
  const pendingTools = new Set<string>();
  for (const original of records) {
    if (hasNestedIdentityConflict(original)) return { ok: false, failure: "context_mismatch" };
    const record = providerPayload(original);
    if (!sessionMatches(record, request.sessionId))
      return { ok: false, failure: "context_mismatch" };
    if (hasHashMismatch(record)) return { ok: false, failure: "context_mismatch" };
    const sequence = record.sequence ?? record.seq;
    if (typeof sequence === "number" && Number.isSafeInteger(sequence)) {
      if (lastSequence !== undefined && sequence <= lastSequence)
        return { ok: false, failure: "context_mismatch" };
      lastSequence = sequence;
    }
    if (record.type === "llm.request" && isRecord(record.request)) {
      requestCount += 1;
      if (typeof record.request.model === "string") model = record.request.model;
      else if (typeof record.model === "string") model = record.model;
      else if (typeof record.model_name === "string") model = record.model_name;
      if (typeof record.time === "number" && Number.isFinite(record.time))
        requestAt = new Date(record.time).toISOString();
      else if (typeof record.time === "string" && !Number.isNaN(Date.parse(record.time)))
        requestAt = new Date(record.time).toISOString();
      else if (typeof record.timestamp === "string" && !Number.isNaN(Date.parse(record.timestamp)))
        requestAt = new Date(record.timestamp).toISOString();
      messages.push(message("user", record.request.messages));
    } else if (record.type === "llm.response") {
      if (requestCount === 0) return { ok: false, failure: "context_mismatch" };
      responseCount += 1;
      messages.push(message("assistant", record.content));
      if (sawTarget) responseFound = true;
    } else if (record.type === "context.append_loop_event" && isRecord(record.event)) {
      const event = record.event;
      if (event.type === "tool.call") {
        const id =
          typeof event.toolCallId === "string"
            ? event.toolCallId
            : typeof event.id === "string"
              ? event.id
              : null;
        const name = typeof event.name === "string" ? event.name : "unknown";
        if (id) {
          if (pendingTools.has(id)) return { ok: false, failure: "context_mismatch" };
          toolNames.set(id, name);
          const parsedArguments = parseToolInput(event.arguments);
          const command =
            isRecord(parsedArguments) && typeof parsedArguments.command === "string"
              ? parsedArguments.command
              : typeof event.command === "string"
                ? event.command
                : undefined;
          if (command) toolCommands.set(id, command);
          pendingTools.add(id);
        } else {
          return { ok: false, failure: "context_mismatch" };
        }
        messages.push(
          message("assistant", [
            {
              type: "tool_use",
              toolName: name,
              toolUseId: id,
              input: parseToolInput(event.arguments),
            },
          ]),
        );
        if (sawTarget) responseFound = true;
      } else if (event.type === "tool.result") {
        const id = typeof event.toolCallId === "string" ? event.toolCallId : null;
        if (!id || !pendingTools.has(id)) return { ok: false, failure: "context_mismatch" };
        pendingTools.delete(id);
        const output =
          typeof event.output === "string" ? event.output : JSON.stringify(event.output ?? "");
        messages.push(
          message("tool", [
            {
              kind: "tool_result",
              toolName: id ? (toolNames.get(id) ?? null) : null,
              toolUseId: id,
              output,
              isError: /^<system>ERROR/.test(output),
            },
          ]),
        );
        if (sawTarget) responseFound = true;
        if (
          id &&
          /\b(?:raft|slock)\s+(?:message\s+send|task\s+reply)\b/.test(toolCommands.get(id) ?? "") &&
          new RegExp(
            `Message ID: ${request.messageId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_-])`,
          ).test(output)
        )
          trigger = { toolUseId: id };
      }
    } else if (record.type === "usage.record" && isRecord(record.usage)) {
      const input =
        (typeof record.usage.inputOther === "number"
          ? record.usage.inputOther
          : typeof record.usage.input_tokens === "number"
            ? record.usage.input_tokens
            : typeof record.usage.inputTokens === "number"
              ? record.usage.inputTokens
              : 0) +
        (typeof record.usage.inputCacheCreation === "number"
          ? record.usage.inputCacheCreation
          : typeof record.usage.cache_creation_input_tokens === "number"
            ? record.usage.cache_creation_input_tokens
            : 0);
      const cacheRead =
        typeof record.usage.inputCacheRead === "number"
          ? record.usage.inputCacheRead
          : typeof record.usage.cached_input_tokens === "number"
            ? record.usage.cached_input_tokens
            : typeof record.usage.cache_read_input_tokens === "number"
              ? record.usage.cache_read_input_tokens
              : 0;
      tokens =
        input + cacheRead > 0
          ? { input, cacheRead, total: input + cacheRead }
          : { input: null, cacheRead: null, total: null };
    } else if (
      record.type === "llm.media" ||
      record.type === "media" ||
      record.type === "context.media"
    ) {
      return { ok: false, failure: "media_removed" };
    } else if (record.type === "context.apply_compaction") {
      const summary =
        typeof record.summary === "string"
          ? record.summary
          : typeof record.content === "string"
            ? record.content
            : null;
      compaction =
        summary === null
          ? { happened: true, summary: null }
          : { happened: true, summary: { kind: "text", text: summary } };
      messages.push(message("system", summary ?? ""));
    }
    if (hasMessageId(record, request.messageId)) {
      sawTarget = true;
      if (record.type === "llm.response" || record.type === "context.append_loop_event")
        responseFound = true;
    }
    if (
      record.type === "unknown_future" ||
      record.type === "unsupported_future" ||
      record.type === "newer_wire_version"
    )
      return { ok: false, failure: "newer_session_format" };
    const refusal = record.refusal ?? record.reason;
    if (typeof refusal === "string") {
      if (refusal === "media_projection") return { ok: false, failure: "media_removed" };
      if (
        [
          "system_prompt_mismatch",
          "tools_unavailable",
          "tools_mismatch",
          "message_count_mismatch",
          "messages_hash_mismatch",
        ].includes(refusal)
      )
        return { ok: false, failure: "context_mismatch" };
      if (refusal === "replay_failed") return { ok: false, failure: "read_failed" };
      if (refusal === "no_request") return { ok: false, failure: "not_found" };
      return { ok: false, failure: "read_failed" };
    }
  }
  if (responseCount > requestCount || pendingTools.size > 0)
    return { ok: false, failure: "context_mismatch" };
  if (!messages.length) return { ok: false, failure: "not_found" };
  const built = buildView(request, messages, "kimi-wire", sawTarget ? "verified" : "count_matched");
  if (built.ok) {
    built.view.responseFound = responseFound;
    built.view.compaction = compaction;
    built.view.model = model;
    built.view.requestAt = requestAt;
    built.view.tokens = tokens;
    if (trigger) built.view.trigger = trigger;
  }
  return built;
}
function piContentParts(content: unknown): unknown[] {
  const items =
    typeof content === "string"
      ? [{ type: "text", text: content }]
      : Array.isArray(content)
        ? content
        : [content];
  return items.flatMap((item) => {
    if (typeof item === "string") return [{ kind: "text", text: item }];
    if (!isRecord(item)) return [];
    if (typeof item.text === "string") return [{ kind: "text", text: item.text }];
    if (item.type === "input_text" || item.type === "output_text")
      return [{ kind: "text", text: typeof item.text === "string" ? item.text : "" }];
    if (Array.isArray(item.tool_calls))
      return item.tool_calls.flatMap((call) =>
        isRecord(call)
          ? [
              {
                kind: "tool_use",
                toolName:
                  isRecord(call.function) && typeof call.function.name === "string"
                    ? call.function.name
                    : "unknown",
                toolUseId: typeof call.id === "string" ? call.id : null,
                input: isRecord(call.function) ? parseToolInput(call.function.arguments) : null,
              },
            ]
          : [],
      );
    if (item.type === "function_call" || item.type === "tool_call")
      return [
        {
          kind: "tool_use",
          toolName: typeof item.name === "string" ? item.name : "unknown",
          toolUseId:
            typeof item.call_id === "string"
              ? item.call_id
              : typeof item.id === "string"
                ? item.id
                : null,
          input: parseToolInput(item.arguments ?? item.input),
        },
      ];
    if (item.type === "function_call_output" || item.type === "tool_result")
      return [
        {
          kind: "tool_result",
          toolName: null,
          toolUseId:
            typeof item.call_id === "string"
              ? item.call_id
              : typeof item.id === "string"
                ? item.id
                : null,
          output:
            typeof item.output === "string"
              ? item.output
              : JSON.stringify(item.output ?? item.content ?? ""),
          isError: false,
        },
      ];
    if (item.content !== undefined) return piContentParts(item.content);
    return [{ kind: "text", text: `[${typeof item.type === "string" ? item.type : "part"}]` }];
  });
}
function piRequestMessages(body: RecordValue, api: string | undefined): RestoredContextMessage[] {
  const raw =
    api === "openai-completions"
      ? (body.messages ?? body.prompt)
      : api === "google-generative-ai" || api === "google-vertex"
        ? body.contents
        : (body.messages ?? body.input);
  if (!Array.isArray(raw)) return [message("user", raw)];
  return raw.flatMap((entry) => {
    if (!isRecord(entry)) return [message("user", entry)];
    const role =
      entry.role === "assistant" ||
      ((api === "google-generative-ai" || api === "google-vertex") && entry.role === "model")
        ? "assistant"
        : entry.role === "system" || entry.role === "developer"
          ? "system"
          : entry.role === "tool"
            ? "tool"
            : "user";
    return [{ role, parts: piContentParts(entry.content ?? entry.parts ?? entry.text ?? entry) }];
  });
}
function piResponseParts(body: unknown): unknown {
  if (isRecord(body) && Array.isArray(body.output))
    return body.output.flatMap((item) =>
      isRecord(item) ? piContentParts(item.content ?? item.output ?? item) : [],
    );
  if (isRecord(body) && Array.isArray(body.contents))
    return body.contents.flatMap((content) =>
      isRecord(content) ? piContentParts(content.parts ?? content.content) : [],
    );
  if (isRecord(body) && Array.isArray(body.choices))
    return body.choices.flatMap((choice) =>
      isRecord(choice)
        ? piContentParts(
            isRecord(choice.message)
              ? choice.message.content
              : isRecord(choice.delta)
                ? (choice.delta.content ?? choice.delta)
                : choice.text,
          )
        : [],
    );
  return piContentParts(body);
}
export function restorePi(
  records: RecordValue[],
  request: RestoreRequest,
): ContextViewRestoreResult {
  const messages: RestoredContextMessage[] = [];
  let previousHash: string | undefined;
  let sawTarget = false;
  let responseSeen = false;
  let requestSeen = false;
  let responseFound = false;
  let trigger: { toolUseId: string } | undefined;
  let model: string | null = null;
  let requestAt: string | null = null;
  const supportedApis = new Set([
    "anthropic-messages",
    "openai-completions",
    "openai-responses",
    "azure-openai-responses",
    "openai-codex-responses",
    "google-generative-ai",
    "google-vertex",
  ]);
  const targetIndex = records.findIndex((record) => hasMessageId(record, request.messageId));
  const boundary =
    targetIndex < 0
      ? records.length
      : records.findIndex((record, index) => index > targetIndex && record.type === "request");
  const bounded = records.slice(0, boundary >= 0 ? boundary : records.length);
  for (const [index, original] of bounded.entries()) {
    if (hasNestedIdentityConflict(original)) return { ok: false, failure: "context_mismatch" };
    const record = providerPayload(original);
    if (!sessionMatches(record, request.sessionId))
      return { ok: false, failure: "context_mismatch" };
    if (hasHashMismatch(record)) return { ok: false, failure: "context_mismatch" };
    const priorHash = previousHash;
    if (typeof record.prevHash === "string" && record.prevHash !== priorHash)
      return { ok: false, failure: "context_mismatch" };
    if (typeof record.hash === "string") previousHash = record.hash;
    const api = record.api ?? (isRecord(record.body) ? record.body.api : undefined);
    if (api !== undefined && (typeof api !== "string" || !supportedApis.has(api)))
      return { ok: false, failure: "unsupported_runtime" };
    if (record.type === "request" && isRecord(record.body)) {
      messages.push(...piRequestMessages(record.body, typeof api === "string" ? api : undefined));
      responseSeen = false;
      requestSeen = true;
      if (typeof record.body.model === "string") model = record.body.model;
      if (typeof record.timestamp === "string") requestAt = record.timestamp;
    } else if (record.type === "response" && requestSeen && !responseSeen) {
      messages.push(message("assistant", piResponseParts(record.body)));
      responseSeen = true;
      if ((targetIndex >= 0 && index > targetIndex) || hasMessageId(record, request.messageId))
        responseFound = true;
      const text =
        typeof record.body === "string" ? record.body : JSON.stringify(record.body ?? "");
      if (
        typeof record.toolCallId === "string" &&
        new RegExp(
          `Message ID: ${request.messageId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_-])`,
        ).test(text)
      )
        trigger = { toolUseId: record.toolCallId };
    } else if (record.type === "gap") return { ok: false, failure: "not_recorded" };
    else if (record.type === "media" || record.type === "request_media")
      return { ok: false, failure: "media_removed" };
    if (record.type === "rollback" || record.type === "thread_rolled_back")
      return { ok: false, failure: "context_mismatch" };
    if (hasMessageId(record, request.messageId)) sawTarget = true;
    if (record.type === "unknown_future" || record.type === "unsupported_future")
      return { ok: false, failure: "newer_session_format" };
  }
  if (!messages.length) return { ok: false, failure: "not_found" };
  const built = buildView(
    request,
    messages,
    "pi-request-log",
    sawTarget ? "verified" : "count_matched",
  );
  if (built.ok) {
    built.view.responseFound = responseFound;
    built.view.model = model;
    built.view.requestAt = requestAt;
    if (trigger) built.view.trigger = trigger;
  }
  return built;
}
