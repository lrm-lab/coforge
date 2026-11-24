import type { AgentRuntimeEvent, createSession } from "@coforge/agent";
import { AGENT_RUNTIME_EVENT_TYPE } from "#src/contract";
import { asRecord, integerField, textContent } from "#src/json-record";
import { buildPromptCacheUsage, type PromptCacheUsage } from "#src/prompt-cache-usage";

type PiSession = Awaited<ReturnType<typeof createSession>>["session"];
export type PiSessionEvent = Parameters<Parameters<PiSession["subscribe"]>[0]>[0];

const CONTENT_FREE_MESSAGE_EVENTS = new Set([
  "start",
  "text_start",
  "thinking_start",
  "toolcall_start",
  "toolcall_delta",
]);

function nonNegativeFinite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function piMessageContextTokens(usage: unknown): number {
  const record = asRecord(usage);
  if (!record) return 0;
  const total = nonNegativeFinite(record.totalTokens);
  if (total > 0) return total;
  return (
    nonNegativeFinite(record.input) +
    nonNegativeFinite(record.output) +
    nonNegativeFinite(record.cacheRead) +
    nonNegativeFinite(record.cacheWrite)
  );
}

export function piPromptCacheUsage(usage: unknown): PromptCacheUsage | undefined {
  const record = asRecord(usage);
  if (!record) return undefined;
  const cachedInputTokens = nonNegativeFinite(record.cacheRead);
  const cacheWriteInputTokens = nonNegativeFinite(record.cacheWrite);
  const inputTokens = nonNegativeFinite(record.input) + cachedInputTokens + cacheWriteInputTokens;
  return buildPromptCacheUsage({
    inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    outputTokens: record.output,
  });
}

export function piSessionEvents(event: PiSessionEvent, windowTokens?: number): AgentRuntimeEvent[] {
  switch (event.type) {
    case "message_update": {
      const message = event.assistantMessageEvent;
      if (message.type === "text_delta") return [{ type: "text-delta", text: message.delta }];
      if (message.type === "thinking_delta")
        return [{ type: "thinking-delta", text: message.delta }];
      return CONTENT_FREE_MESSAGE_EVENTS.has(message.type)
        ? [{ type: "progress", source: "pi_message_event" }]
        : [];
    }
    case "message_end": {
      if (
        event.message.role !== "assistant" ||
        event.message.stopReason === "error" ||
        event.message.stopReason === "aborted"
      )
        return [];
      const events: AgentRuntimeEvent[] = [];
      const usedTokens = piMessageContextTokens(event.message.usage);
      const hasWindow =
        windowTokens !== undefined && Number.isFinite(windowTokens) && windowTokens > 0;
      if (hasWindow && usedTokens > 0) {
        events.push({ type: AGENT_RUNTIME_EVENT_TYPE.CONTEXT_USAGE, usedTokens, windowTokens });
      }
      const cacheUsage = piPromptCacheUsage(event.message.usage);
      const outputTokens = Math.round(nonNegativeFinite(asRecord(event.message.usage)?.output));
      const model =
        typeof event.message.model === "string" && event.message.model.trim()
          ? event.message.model.trim()
          : undefined;
      if (cacheUsage || outputTokens > 0) {
        events.push({
          type: AGENT_RUNTIME_EVENT_TYPE.TOKEN_USAGE,
          usage: {
            uncachedInputTokens: Math.round(cacheUsage?.uncachedInputTokens ?? 0),
            cacheReadTokens: Math.round(cacheUsage?.cachedInputTokens ?? 0),
            cacheWriteTokens: Math.round(cacheUsage?.cacheWriteInputTokens ?? 0),
            outputTokens: Math.round(cacheUsage?.outputTokens ?? outputTokens),
            ...(model ? { model } : {}),
            ...(hasWindow && usedTokens > 0
              ? {
                  contextUsedTokens: Math.round(usedTokens),
                  contextWindowTokens: Math.round(windowTokens),
                }
              : {}),
          },
        });
      }
      return events;
    }
    case "turn_start":
    case "message_start":
      return [{ type: "progress", source: "pi_turn_lifecycle" }];
    case "auto_retry_start":
    case "summarization_retry_scheduled":
      return [
        {
          type: "reconnecting",
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          delayMs: event.delayMs,
          message: event.errorMessage,
        },
      ];
    case "compaction_start":
      return [{ type: "compaction-started" }];
    case "compaction_end": {
      if (event.aborted || !event.result)
        return [
          {
            type: "compaction-interrupted",
            interruptedBy: event.aborted ? "aborted" : "failed",
            reason: event.reason,
            ...(event.errorMessage ? { errorMessage: event.errorMessage } : {}),
          },
        ];
      return [
        {
          type: "compaction-finished",
          tokensBefore: event.result.tokensBefore,
          tokensAfter: event.result.estimatedTokensAfter,
          windowTokens,
        },
      ];
    }
    case "tool_execution_start":
      return [
        { type: "tool-start", id: event.toolCallId, name: event.toolName, input: event.args },
      ];
    case "tool_execution_update": {
      const text = textContent(event.partialResult.content);
      return text ? [{ type: "tool-output", id: event.toolCallId, text }] : [];
    }
    case "tool_execution_end":
      return [
        {
          type: "tool-end",
          id: event.toolCallId,
          isError: event.isError,
          exitCode: integerField(asRecord(asRecord(event.result)?.structuredContent)?.exit_code),
          durationMs: event.durationMs,
        },
      ];
    default:
      return [];
  }
}
