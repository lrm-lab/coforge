import type { InlineExtension, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";

export type CompactionPreparation = SessionBeforeCompactEvent["preparation"];
export type CompactionMessage = CompactionPreparation["messagesToSummarize"][number];

const TOOL_RESULT_SERIALIZE_MAX_CHARS = 2_000;
const MIN_COMPACTION_INPUT_BUDGET = 8_000;
const COMPACTION_PROMPT_OVERHEAD_TOKENS = 8_000;
const COMPACTION_WINDOW_RATIO = 0.65;
const TRUNCATION_MARKER = "\n[... truncated for compaction budget ...]\n";

function isCjkCodePoint(code: number): boolean {
  return (
    (code >= 0x3000 && code <= 0x30ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xffef)
  );
}

export function estimateCjkAwareTokens(text: string): number {
  if (!text) return 0;
  let cjkChars = 0;
  for (let i = 0; i < text.length; i++) {
    if (isCjkCodePoint(text.charCodeAt(i))) cjkChars += 1;
  }
  const nonCjkChars = text.length - cjkChars;
  return Math.ceil(cjkChars / 1.5 + nonCjkChars / 4);
}

function estimateBlockTokens(block: unknown, isToolResult: boolean): number {
  if (typeof block === "string") {
    const effective = isToolResult ? block.slice(0, TOOL_RESULT_SERIALIZE_MAX_CHARS) : block;
    return estimateCjkAwareTokens(effective);
  }
  if (typeof block !== "object" || block === null) return 0;
  const record = block as Record<string, unknown>;
  if (record.type === "image" || record.type === "thinking") return 0;
  if (typeof record.text === "string") {
    const effective = isToolResult
      ? record.text.slice(0, TOOL_RESULT_SERIALIZE_MAX_CHARS)
      : record.text;
    return estimateCjkAwareTokens(effective);
  }
  if (record.type === "toolCall") {
    const name = typeof record.name === "string" ? record.name : "";
    const args = record.arguments !== undefined ? JSON.stringify(record.arguments) : "";
    return estimateCjkAwareTokens(name) + estimateCjkAwareTokens(args);
  }
  return 0;
}

export function estimateMessageTokens(message: CompactionMessage): number {
  const record = message as unknown as Record<string, unknown>;
  const role = typeof record.role === "string" ? record.role : "";
  if (role === "bashExecution") {
    const command = typeof record.command === "string" ? record.command : "";
    const output = typeof record.output === "string" ? record.output : "";
    return estimateCjkAwareTokens(command) + estimateCjkAwareTokens(output);
  }
  if (role === "branchSummary" || role === "compactionSummary") {
    return typeof record.summary === "string" ? estimateCjkAwareTokens(record.summary) : 0;
  }
  const isToolResult = role === "toolResult";
  const content = record.content;
  if (typeof content === "string") {
    const effective = isToolResult ? content.slice(0, TOOL_RESULT_SERIALIZE_MAX_CHARS) : content;
    return estimateCjkAwareTokens(effective);
  }
  if (Array.isArray(content)) {
    let total = 0;
    for (const block of content) total += estimateBlockTokens(block, isToolResult);
    return total;
  }
  return 0;
}

function truncateTextToBudget(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const available = Math.max(200, maxChars - TRUNCATION_MARKER.length);
  const headChars = Math.floor(available * 0.6);
  const tailChars = available - headChars;
  return `${text.slice(0, headChars)}${TRUNCATION_MARKER}${text.slice(text.length - tailChars)}`;
}

function truncateToolArguments(
  value: unknown,
  maxChars: number,
): { value: unknown; truncated: number } {
  if (typeof value === "string") {
    if (value.length <= maxChars) return { value, truncated: 0 };
    return { value: truncateTextToBudget(value, maxChars), truncated: 1 };
  }
  if (Array.isArray(value)) {
    let truncated = 0;
    let changed = false;
    const next = value.map((item) => {
      const res = truncateToolArguments(item, maxChars);
      if (res.truncated > 0) {
        truncated += res.truncated;
        changed = true;
      }
      return res.value;
    });
    return { value: changed ? next : value, truncated };
  }
  if (typeof value === "object" && value !== null) {
    let truncated = 0;
    let changed = false;
    const clone: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const res = truncateToolArguments(entry, maxChars);
      if (res.truncated > 0) {
        truncated += res.truncated;
        changed = true;
      }
      clone[key] = res.value;
    }
    return { value: changed ? clone : value, truncated };
  }
  return { value, truncated: 0 };
}

function cloneWithTruncatedBlocks(
  message: CompactionMessage,
  maxBlockChars: number,
): { message: CompactionMessage; truncated: number } {
  const record = message as unknown as Record<string, unknown>;
  const role = typeof record.role === "string" ? record.role : "";
  if (role === "bashExecution") {
    const output = typeof record.output === "string" ? record.output : undefined;
    if (output && output.length > maxBlockChars) {
      return {
        message: {
          ...record,
          output: truncateTextToBudget(output, maxBlockChars),
        } as unknown as CompactionMessage,
        truncated: 1,
      };
    }
    return { message, truncated: 0 };
  }
  if (role === "branchSummary" || role === "compactionSummary") {
    const summary = typeof record.summary === "string" ? record.summary : undefined;
    if (summary && summary.length > maxBlockChars) {
      return {
        message: {
          ...record,
          summary: truncateTextToBudget(summary, maxBlockChars),
        } as unknown as CompactionMessage,
        truncated: 1,
      };
    }
    return { message, truncated: 0 };
  }
  const content = record.content;
  if (typeof content === "string") {
    if (content.length <= maxBlockChars) return { message, truncated: 0 };
    return {
      message: {
        ...record,
        content: truncateTextToBudget(content, maxBlockChars),
      } as unknown as CompactionMessage,
      truncated: 1,
    };
  }
  if (!Array.isArray(content)) return { message, truncated: 0 };
  let truncated = 0;
  const nextContent = content.map((block) => {
    if (typeof block !== "object" || block === null) return block;
    const item = block as Record<string, unknown>;
    if (typeof item.text === "string" && item.text.length > maxBlockChars) {
      truncated += 1;
      return { ...item, text: truncateTextToBudget(item.text, maxBlockChars) };
    }
    if (item.type === "toolCall" && item.arguments !== undefined) {
      const argResult = truncateToolArguments(item.arguments, maxBlockChars);
      if (argResult.truncated > 0) {
        truncated += argResult.truncated;
        return { ...item, arguments: argResult.value };
      }
    }
    return block;
  });
  if (truncated === 0) return { message, truncated: 0 };
  return {
    message: { ...record, content: nextContent } as unknown as CompactionMessage,
    truncated,
  };
}

function truncateArrayInPlace(messages: CompactionMessage[], maxBlockChars: number): number {
  let truncated = 0;
  for (let i = 0; i < messages.length; i++) {
    const res = cloneWithTruncatedBlocks(messages[i]!, maxBlockChars);
    if (res.truncated > 0) {
      messages[i] = res.message;
      truncated += res.truncated;
    }
  }
  return truncated;
}

function dropOldestToFit(
  messages: CompactionMessage[],
  tokens: number[],
  total: number,
  budget: number,
): { total: number; dropped: number } {
  let dropCount = 0;
  while (total > budget && messages.length - dropCount > 1) {
    total -= tokens[dropCount]!;
    dropCount += 1;
  }
  if (dropCount > 0) messages.splice(0, dropCount);
  return { total, dropped: dropCount };
}

export function trimCompactionPreparation(
  preparation: CompactionPreparation,
  contextWindowTokens: number,
): { trimmed: boolean; droppedMessages: number; truncatedBlocks: number } {
  if (!Number.isFinite(contextWindowTokens) || contextWindowTokens <= 0) {
    return { trimmed: false, droppedMessages: 0, truncatedBlocks: 0 };
  }
  const previousSummaryTokens = preparation.previousSummary
    ? estimateCjkAwareTokens(preparation.previousSummary)
    : 0;
  const maxSmallWindowBudget = Math.max(1_000, Math.floor(contextWindowTokens * 0.5));
  const computedBudget =
    Math.floor(contextWindowTokens * COMPACTION_WINDOW_RATIO) -
    previousSummaryTokens -
    COMPACTION_PROMPT_OVERHEAD_TOKENS;
  const budget = Math.min(
    maxSmallWindowBudget,
    Math.max(Math.min(MIN_COMPACTION_INPUT_BUDGET, maxSmallWindowBudget), computedBudget),
  );

  const mainTokens = preparation.messagesToSummarize.map(estimateMessageTokens);
  const prefixTokens = preparation.turnPrefixMessages.map(estimateMessageTokens);
  let total =
    mainTokens.reduce((sum, count) => sum + count, 0) +
    prefixTokens.reduce((sum, count) => sum + count, 0);
  if (total <= budget) {
    return { trimmed: false, droppedMessages: 0, truncatedBlocks: 0 };
  }

  let truncatedBlocks = 0;
  let droppedMessages = 0;
  const maxBlockChars = Math.max(2_000, Math.floor(budget * 0.2) * 2);
  truncatedBlocks += truncateArrayInPlace(preparation.messagesToSummarize, maxBlockChars);
  truncatedBlocks += truncateArrayInPlace(preparation.turnPrefixMessages, maxBlockChars);

  const updatedMainTokens = preparation.messagesToSummarize.map(estimateMessageTokens);
  const updatedPrefixTokens = preparation.turnPrefixMessages.map(estimateMessageTokens);
  total =
    updatedMainTokens.reduce((sum, count) => sum + count, 0) +
    updatedPrefixTokens.reduce((sum, count) => sum + count, 0);

  const mainDrop = dropOldestToFit(
    preparation.messagesToSummarize,
    updatedMainTokens,
    total,
    budget,
  );
  total = mainDrop.total;
  droppedMessages += mainDrop.dropped;

  const prefixDrop = dropOldestToFit(
    preparation.turnPrefixMessages,
    updatedPrefixTokens,
    total,
    budget,
  );
  total = prefixDrop.total;
  droppedMessages += prefixDrop.dropped;

  if (total > budget) {
    const tightChars = Math.max(1_000, Math.floor(budget * 1.2));
    truncatedBlocks += truncateArrayInPlace(preparation.messagesToSummarize, tightChars);
    truncatedBlocks += truncateArrayInPlace(preparation.turnPrefixMessages, tightChars);
  }
  return {
    trimmed: truncatedBlocks > 0 || droppedMessages > 0,
    droppedMessages,
    truncatedBlocks,
  };
}

export function createCompactionGuardExtension(
  resolveContextWindow: () => number | undefined,
): InlineExtension {
  return {
    name: "coforge-compaction-guard",
    factory(pi) {
      pi.on("session_before_compact", (event, ctx) => {
        const windowTokens = ctx.model?.contextWindow ?? resolveContextWindow();
        if (windowTokens && Number.isFinite(windowTokens) && windowTokens > 0) {
          const { tokensBefore } = event.preparation;
          const summaryWindow =
            event.reason === "overflow" && Number.isSafeInteger(tokensBefore) && tokensBefore > 0
              ? Math.min(windowTokens, tokensBefore)
              : windowTokens;
          trimCompactionPreparation(event.preparation, summaryWindow);
        }
      });
    },
  };
}
