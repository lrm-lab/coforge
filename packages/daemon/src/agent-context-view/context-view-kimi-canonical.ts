import { createHash } from "node:crypto";
import type { RecordValue, RestoredContextView } from "./context-view-restore";
import { isRecord, parseToolInput, providerPayload } from "./context-view-restore";

export type KimiCanonicalState = {
  messages: RecordValue[];
  tools: Map<string, unknown>;
  verification?: RestoredContextView["verification"];
};

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function messagesHash(messages: readonly unknown[]): string {
  const hash = createHash("sha256");
  for (const value of messages) {
    const message = isRecord(value) ? value : {};
    const content = Array.isArray(message.content)
      ? message.content.map((part) =>
          isRecord(part) &&
          (part.type === "image_url" || part.type === "audio_url" || part.type === "video_url")
            ? { type: part.type }
            : part,
        )
      : message.content;
    hash.update(canonicalJson({ ...message, content }));
    hash.update("\n");
  }
  return hash.digest("hex");
}

function loopEventMessage(event: RecordValue): RecordValue | undefined {
  if (event.type === "tool.call") {
    const id = typeof event.toolCallId === "string" ? event.toolCallId : event.id;
    if (typeof id !== "string") return undefined;
    return {
      role: "assistant",
      content: [],
      toolCalls: [
        {
          id,
          name: typeof event.name === "string" ? event.name : "unknown",
          input: parseToolInput(event.arguments ?? event.args),
        },
      ],
    };
  }
  if (event.type === "tool.result" && typeof event.toolCallId === "string")
    return {
      role: "tool",
      content: [
        {
          type: "text",
          text:
            typeof event.output === "string" ? event.output : JSON.stringify(event.output ?? ""),
        },
      ],
      toolCallId: event.toolCallId,
    };
  return undefined;
}

function applyRecord(state: KimiCanonicalState, record: RecordValue): void {
  if (record.type === "llm.tools_snapshot" && typeof record.hash === "string") {
    state.tools.set(record.hash, record.tools);
  } else if (record.type === "context.append_message" && isRecord(record.message)) {
    state.messages.push(record.message);
  } else if (record.type === "context.clear") {
    state.messages.length = 0;
  } else if (record.type === "context.undo") {
    const count =
      typeof record.count === "number" && Number.isSafeInteger(record.count) ? record.count : 0;
    for (let remaining = Math.max(0, count); remaining > 0; remaining -= 1) {
      let cut = -1;
      for (let index = state.messages.length - 1; index >= 0; index -= 1) {
        if (state.messages[index]?.role === "user") {
          cut = index;
          break;
        }
      }
      if (cut < 0) break;
      state.messages.splice(cut);
    }
  } else if (record.type === "context.apply_compaction") {
    state.messages.length = 0;
    const summary =
      typeof record.summary === "string"
        ? record.summary
        : typeof record.contextSummary === "string"
          ? record.contextSummary
          : typeof record.content === "string"
            ? record.content
            : null;
    if (summary !== null)
      state.messages.push({ role: "system", content: [{ type: "text", text: summary }] });
  } else if (record.type === "context.append_loop_event" && isRecord(record.event)) {
    const folded = loopEventMessage(record.event);
    if (folded) state.messages.push(folded);
  }
}

function stripDynamicToolContext(messages: RecordValue[]): RecordValue[] {
  return messages.flatMap((message) => {
    if (!Array.isArray(message.tools) || message.tools.length === 0) return [message];
    const { tools: _tools, ...rest } = message;
    const content = Array.isArray(rest.content) ? rest.content : undefined;
    const toolCalls = Array.isArray(rest.toolCalls) ? rest.toolCalls : undefined;
    return content?.length === 0 && toolCalls?.length === 0 ? [] : [rest];
  });
}

export function projectKimiRequestMessages(
  payload: RecordValue,
  state: KimiCanonicalState,
): RecordValue[] {
  const sourceMessages = state.messages.length
    ? state.messages
    : Array.isArray(payload.messages)
      ? payload.messages.filter(isRecord)
      : [];
  return projectKimiCanonicalMessages(sourceMessages, payload);
}

function strictProjection(messages: RecordValue[]): RecordValue[] {
  const firstUser = messages.findIndex((message) => message.role === "user");
  const projected = firstUser < 0 ? [] : messages.slice(firstUser);
  const merged: RecordValue[] = [];
  const seenCalls = new Set<string>();
  const seenResults = new Set<string>();
  for (const message of projected) {
    const toolCalls = Array.isArray(message.toolCalls)
      ? message.toolCalls.filter((call) => {
          if (!isRecord(call) || typeof call.id !== "string") return true;
          if (seenCalls.has(call.id)) return false;
          seenCalls.add(call.id);
          return true;
        })
      : [];
    if (message.role === "tool" && typeof message.toolCallId === "string") {
      if (seenResults.has(message.toolCallId)) continue;
      seenResults.add(message.toolCallId);
    }
    const previous = merged.at(-1);
    if (previous?.role === "assistant" && message.role === "assistant") {
      previous.content = [
        ...(Array.isArray(previous.content) ? previous.content : []),
        ...(Array.isArray(message.content) ? message.content : []),
      ];
      previous.toolCalls = [
        ...(Array.isArray(previous.toolCalls) ? previous.toolCalls : []),
        ...toolCalls,
      ];
      continue;
    }
    merged.push({ ...message, toolCalls });
  }
  return merged;
}

export function projectKimiCanonicalMessages(
  messages: RecordValue[],
  payload: RecordValue,
): RecordValue[] {
  const dynamic = payload.toolSelect === true ? messages : stripDynamicToolContext(messages);
  return payload.projection === "strict" ? strictProjection(dynamic) : dynamic;
}

export function prepareKimiCanonicalState(
  records: readonly RecordValue[],
  latestLoopIndex: number,
): KimiCanonicalState {
  const state: KimiCanonicalState = { messages: [], tools: new Map() };
  for (const original of records.slice(0, Math.max(0, latestLoopIndex)))
    applyRecord(state, providerPayload(original));
  return state;
}

export function isNewerKimiWireRecord(record: RecordValue): boolean {
  if (record.type !== "metadata" || typeof record.protocol_version !== "string") return false;
  const [majorText, minorText] = record.protocol_version.split(/[.-]/, 2);
  const major = Number.parseInt(majorText ?? "", 10);
  const minor = Number.parseInt(minorText ?? "0", 10);
  return (
    Number.isFinite(major) && Number.isFinite(minor) && (major > 1 || (major === 1 && minor > 5))
  );
}

export function hasKimiCanonicalFields(payload: RecordValue, record: RecordValue): boolean {
  return (
    typeof record.kind === "string" ||
    typeof payload.systemPromptHash === "string" ||
    typeof payload.toolsHash === "string" ||
    typeof payload.messageCount === "number" ||
    typeof payload.messagesHash === "string"
  );
}

export function validateKimiCanonicalRequest(
  payload: RecordValue,
  state: KimiCanonicalState,
): "media_removed" | "context_mismatch" | undefined {
  if (payload.projection && String(payload.projection).includes("media")) return "media_removed";
  if (
    typeof payload.systemPrompt === "string" &&
    typeof payload.systemPromptHash === "string" &&
    sha256(payload.systemPrompt) !== payload.systemPromptHash
  )
    return "context_mismatch";
  if (typeof payload.toolsHash === "string") {
    const tools = state.tools.get(payload.toolsHash);
    if (tools === undefined || sha256(JSON.stringify(tools)) !== payload.toolsHash)
      return "context_mismatch";
  }
  const projectedMessages = projectKimiRequestMessages(payload, state);
  if (typeof payload.messageCount === "number" && projectedMessages.length !== payload.messageCount)
    return "context_mismatch";
  if (
    typeof payload.messagesHash === "string" &&
    messagesHash(projectedMessages) !== payload.messagesHash
  )
    return "context_mismatch";
  state.verification = typeof payload.messagesHash === "string" ? "verified" : "count_matched";
}
