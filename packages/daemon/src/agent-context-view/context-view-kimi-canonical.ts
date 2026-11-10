import { createHash } from "node:crypto";
import type { RecordValue, RestoredContextView } from "./context-view-restore";
import { isRecord, parseToolInput, providerPayload } from "./context-view-restore";

export type KimiCanonicalState = {
  messages: RecordValue[];
  tools: Map<string, unknown>;
  verification?: RestoredContextView["verification"];
  unsupportedChain?: boolean;
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
  const prefix = records.slice(0, Math.max(0, latestLoopIndex));
  const flattened = flattenKimiChain(prefix);
  if (flattened === undefined) {
    state.unsupportedChain = true;
    return state;
  }
  for (const original of flattened) applyRecord(state, providerPayload(original));
  return state;
}

function flattenKimiChain(records: readonly RecordValue[]): RecordValue[] | undefined {
  const switches = records
    .map((record, index) => ({ record, line: index + 1 }))
    .filter(({ record }) => record.type === "agent.switched");
  if (switches.length === 0) return [...records];
  const byBranch = new Map<string, { line: number; baseBranch: string; baseLine: number }>();
  for (const { record, line } of switches) {
    const branch = record.branch;
    const base = isRecord(record.base) ? record.base : undefined;
    if (
      typeof branch !== "string" ||
      !base ||
      typeof base.branch !== "string" ||
      typeof base.line !== "number" ||
      !Number.isSafeInteger(base.line) ||
      base.line < 0
    )
      return undefined;
    byBranch.set(branch, { line, baseBranch: base.branch, baseLine: base.line });
  }
  const activeBranch = switches.at(-1)?.record.branch;
  if (typeof activeBranch !== "string") return undefined;
  const activeLines = new Set<number>();
  const visited = new Set<string>();
  const walk = (branch: string, until: number): boolean => {
    if (visited.has(branch)) return false;
    visited.add(branch);
    const edge = byBranch.get(branch);
    const floor = edge === undefined ? 1 : edge.line + 1;
    if (edge !== undefined && !walk(edge.baseBranch, edge.baseLine)) return false;
    for (let line = floor; line <= until; line += 1) {
      const record = records[line - 1];
      if (record?.type !== "agent.switched") activeLines.add(line);
    }
    return true;
  };
  if (!walk(activeBranch, records.length)) return undefined;
  const pairedUndoLines = new Set(
    switches
      .map(({ record }) => record.legacyUndoLine)
      .filter((line): line is number => typeof line === "number" && Number.isSafeInteger(line)),
  );
  const survivingPromptIds = new Set<string>();
  const chain = records.filter((record, index) => {
    const line = index + 1;
    if (!activeLines.has(line)) return false;
    if (record.type === "context.undone") return false;
    if (record.type === "context.undo" && pairedUndoLines.has(line)) return false;
    if (record.type === "context.append_message" && isRecord(record.message)) {
      if (record.message.role === "user" && typeof record.message.id === "string")
        survivingPromptIds.add(record.message.id);
    }
    return true;
  });
  const injections = records.filter((record, index) => {
    if (activeLines.has(index + 1) || record.type !== "context.append_message") return false;
    const message = isRecord(record.message) ? record.message : undefined;
    const origin = message && isRecord(message.origin) ? message.origin : undefined;
    return (
      origin?.kind === "injection" &&
      (typeof origin.ownerPromptId !== "string" || survivingPromptIds.has(origin.ownerPromptId))
    );
  });
  return [...chain, ...injections];
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
