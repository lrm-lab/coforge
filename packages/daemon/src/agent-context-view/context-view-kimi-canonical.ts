import { createHash } from "node:crypto";
import type { RecordValue, RestoredContextView } from "./context-view-restore";
import { isRecord, parseToolInput, providerPayload } from "./context-view-restore";

export type KimiCanonicalState = {
  messages: RecordValue[];
  tools: Map<string, unknown>;
  verification?: RestoredContextView["verification"];
  unsupportedChain?: boolean;
  openSteps: Map<string, number>;
  pendingToolResultIds: Set<string>;
  deferredMessages: RecordValue[];
  systemPrompt: string;
};

const TOOL_EXECUTION_INTERRUPTED =
  "Tool execution was interrupted before its result was recorded. Do not assume the tool completed successfully.";
const TOOL_RESULT_UNAVAILABLE =
  "Tool result is not available in the current context. Do not assume the tool completed successfully.";

function resetReplayState(state: KimiCanonicalState): void {
  state.openSteps.clear();
  state.pendingToolResultIds.clear();
  state.deferredMessages.length = 0;
}

function pushMessages(state: KimiCanonicalState, messages: RecordValue[]): void {
  if (state.pendingToolResultIds.size > 0) state.deferredMessages.push(...messages);
  else state.messages.push(...messages);
}

function flushDeferredMessages(state: KimiCanonicalState): void {
  if (state.pendingToolResultIds.size > 0 || state.deferredMessages.length === 0) return;
  state.messages.push(...state.deferredMessages);
  state.deferredMessages.length = 0;
}

function closePendingToolResults(state: KimiCanonicalState): void {
  if (state.pendingToolResultIds.size === 0) return;
  for (const toolCallId of state.pendingToolResultIds)
    state.messages.push({
      role: "tool",
      content: [{ type: "text", text: TOOL_EXECUTION_INTERRUPTED }],
      toolCallId,
      isError: true,
    });
  state.pendingToolResultIds.clear();
  flushDeferredMessages(state);
}

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
  if (
    (record.type === "config.update" || record.type === "profile.bind") &&
    typeof record.systemPrompt === "string"
  ) {
    state.systemPrompt = record.systemPrompt;
  } else if (record.type === "llm.tools_snapshot" && typeof record.hash === "string") {
    state.tools.set(record.hash, record.tools);
  } else if (record.type === "context.append_message" && isRecord(record.message)) {
    pushMessages(state, [record.message]);
  } else if (record.type === "context.clear") {
    state.messages.length = 0;
    resetReplayState(state);
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
    resetReplayState(state);
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
      state.messages.push({
        role: "user",
        content: [{ type: "text", text: summary }],
        origin: { kind: "compaction_summary" },
        toolCalls: [],
      });
    resetReplayState(state);
  } else if (record.type === "context.append_loop_event" && isRecord(record.event)) {
    const event = record.event;
    if (event.type === "step.begin") {
      closePendingToolResults(state);
      const message: RecordValue = { role: "assistant", content: [], toolCalls: [] };
      state.messages.push(message);
      if (typeof event.uuid === "string")
        state.openSteps.set(event.uuid, state.messages.length - 1);
      return;
    }
    if (event.type === "step.end") {
      if (typeof event.uuid === "string") state.openSteps.delete(event.uuid);
      if (state.openSteps.size === 0) {
        let open: RecordValue | undefined;
        for (let index = state.messages.length - 1; index >= 0; index -= 1) {
          const candidate = state.messages[index];
          if (candidate?.role === "assistant" && candidate.partial === true) {
            open = candidate;
            break;
          }
        }
        if (open) delete open.partial;
      }
      flushDeferredMessages(state);
      return;
    }
    if (event.type === "content.part") {
      const index =
        typeof event.stepUuid === "string" ? state.openSteps.get(event.stepUuid) : undefined;
      if (index !== undefined) {
        const message = state.messages[index];
        if (!message) return;
        message.content = [...(Array.isArray(message.content) ? message.content : []), event.part];
      }
      return;
    }
    if (event.type === "tool.call") {
      const index =
        typeof event.stepUuid === "string" ? state.openSteps.get(event.stepUuid) : undefined;
      if (index !== undefined) {
        const message = state.messages[index];
        if (!message) return;
        const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
        if (toolCallId) {
          message.toolCalls = [
            ...(Array.isArray(message.toolCalls) ? message.toolCalls : []),
            {
              id: toolCallId,
              name: typeof event.name === "string" ? event.name : "unknown",
              input: event.args ?? null,
            },
          ];
          state.pendingToolResultIds.add(toolCallId);
        }
        return;
      }
    }
    if (event.type === "tool.result" && typeof event.toolCallId === "string") {
      if (!state.pendingToolResultIds.has(event.toolCallId)) return;
      const result = isRecord(event.result) ? event.result : undefined;
      const output = result?.output ?? event.output ?? "";
      pushMessages(state, [
        {
          role: "tool",
          content: [
            { type: "text", text: typeof output === "string" ? output : JSON.stringify(output) },
          ],
          toolCallId: event.toolCallId,
          isError: result?.isError === true,
        },
      ]);
      state.pendingToolResultIds.delete(event.toolCallId);
      flushDeferredMessages(state);
      return;
    }
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

function pairToolBlocks(messages: RecordValue[]): RecordValue[] {
  type Pending = { id: string; result?: RecordValue };
  type Block = { message: RecordValue; pending: Pending[] };
  const blocks: Block[] = [];
  const open = new Map<string, Pending>();
  for (const message of messages) {
    if (message.partial === true) continue;
    if (message.role === "tool" && typeof message.toolCallId === "string") {
      const pending = open.get(message.toolCallId);
      if (!pending) continue;
      pending.result = message;
      open.delete(message.toolCallId);
      continue;
    }
    const block: Block = { message, pending: [] };
    blocks.push(block);
    if (message.role === "assistant" && Array.isArray(message.toolCalls)) {
      for (const call of message.toolCalls) {
        if (!isRecord(call) || typeof call.id !== "string") continue;
        const previous = open.get(call.id);
        if (previous) {
          previous.result = {
            role: "tool",
            content: [{ type: "text", text: TOOL_RESULT_UNAVAILABLE }],
            toolCallId: call.id,
            isError: true,
          };
          open.delete(call.id);
        }
        const pending: Pending = { id: call.id };
        block.pending.push(pending);
        open.set(call.id, pending);
      }
    }
  }
  const out: RecordValue[] = [];
  for (const block of blocks) {
    out.push(block.message);
    for (const pending of block.pending)
      out.push(
        pending.result ?? {
          role: "tool",
          content: [{ type: "text", text: TOOL_RESULT_UNAVAILABLE }],
          toolCallId: pending.id,
          isError: true,
        },
      );
  }
  return out;
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
  const paired = pairToolBlocks(dynamic);
  return payload.projection === "strict" ? strictProjection(paired) : paired;
}

export function prepareKimiCanonicalState(
  records: readonly RecordValue[],
  latestLoopIndex: number,
): KimiCanonicalState {
  const state: KimiCanonicalState = {
    messages: [],
    tools: new Map(),
    openSteps: new Map(),
    pendingToolResultIds: new Set(),
    deferredMessages: [],
    systemPrompt: "",
  };
  const prefix = records.slice(0, Math.max(0, latestLoopIndex));
  const flattened = flattenKimiChain(prefix);
  if (flattened === undefined) {
    state.unsupportedChain = true;
    return state;
  }
  for (const original of flattened) applyRecord(state, providerPayload(original));
  return state;
}

export function responseAfterKimiRequest(
  records: readonly RecordValue[],
  latestLoopIndex: number,
  state: KimiCanonicalState,
): RecordValue | undefined {
  let responseIndex = -1;
  for (let index = state.messages.length - 1; index >= 0; index -= 1) {
    const candidate = state.messages[index];
    if (candidate?.role === "assistant" && candidate.partial === true) {
      responseIndex = index;
      break;
    }
  }
  if (responseIndex < 0) return undefined;
  const after: KimiCanonicalState = {
    ...state,
    messages: state.messages.map((message) => ({ ...message })),
    openSteps: new Map(state.openSteps),
    pendingToolResultIds: new Set(state.pendingToolResultIds),
    deferredMessages: [...state.deferredMessages],
    systemPrompt: state.systemPrompt,
  };
  for (let index = latestLoopIndex + 1; index < records.length; index += 1) {
    const record = providerPayload(records[index]!);
    if (
      [
        "context.apply_compaction",
        "context.clear",
        "context.undo",
        "agent.switched",
        "llm.request",
      ].includes(String(record.type))
    )
      break;
    applyRecord(after, record);
    if (after.messages.length <= responseIndex) break;
  }
  const candidate = after.messages[responseIndex];
  return candidate?.role === "assistant" && candidate.partial !== true ? candidate : undefined;
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
    typeof payload.systemPromptHash === "string" &&
    sha256(typeof payload.systemPrompt === "string" ? payload.systemPrompt : state.systemPrompt) !==
      payload.systemPromptHash
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
