import {
  claudeUsageContextTokens,
  findClaudeSessionTranscript,
  transcriptRecords,
  type ClaudeHistoryHost,
} from "@lrm/coforge-anvil/claude-code";
import { truncateCodePointsWithEllipsis } from "@lrm/coforge-sdk/internal";
import { claudeHistoryHost } from "./history-host";

const SIDE_ASK_TAIL_BYTES = 512 * 1024;
const MAX_OPEN_TODOS = 5;
const MAX_TODO_CHARS = 120;
const MAX_NOTE_CHARS = 400;

export type ClaudeSideAskTodo = Readonly<{
  content: string;
  status: string;
  activeForm?: string;
}>;

export type ClaudeSideAskTranscriptState = Readonly<{
  transcriptPath: string;
  openTodos: readonly ClaudeSideAskTodo[];
  openTodoCount: number;
  totalTodos: number;
  latestNote?: string;
  contextTokens?: number;
}>;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function foldSingleLine(value: string, maxChars: number): string {
  let cleaned = "";
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    cleaned += code < 32 || code === 127 ? " " : value[i]!;
  }
  const collapsed = cleaned.replace(/\s+/g, " ").trim();
  return truncateCodePointsWithEllipsis(collapsed, maxChars);
}

function extractTodos(input: unknown): ClaudeSideAskTodo[] | undefined {
  const record = asRecord(input);
  if (!record || !Array.isArray(record.todos)) return undefined;
  const todos: ClaudeSideAskTodo[] = [];
  for (const item of record.todos) {
    const entry = asRecord(item);
    if (!entry || typeof entry.content !== "string" || typeof entry.status !== "string") continue;
    const content = foldSingleLine(entry.content, MAX_TODO_CHARS);
    const status = foldSingleLine(entry.status, 32);
    if (!content || !status) continue;
    const activeForm =
      typeof entry.activeForm === "string"
        ? foldSingleLine(entry.activeForm, MAX_TODO_CHARS)
        : undefined;
    todos.push({
      content,
      status,
      ...(activeForm ? { activeForm } : {}),
    });
  }
  return todos;
}

export async function readClaudeSideAskState(
  sessionId: string,
  envVars: Readonly<Record<string, string>> | undefined,
  host: ClaudeHistoryHost = claudeHistoryHost,
): Promise<ClaudeSideAskTranscriptState | undefined> {
  const transcriptPath = await findClaudeSessionTranscript(sessionId, envVars, host);
  if (!transcriptPath) return undefined;
  let tail: { text: string; startOffset: number };
  try {
    tail = await host.readFileTail(transcriptPath, SIDE_ASK_TAIL_BYTES);
  } catch {
    return undefined;
  }
  const lines = tail.text.split("\n");
  if (tail.startOffset > 0) lines.shift();
  let latestTodos: ClaudeSideAskTodo[] | undefined;
  let latestNote: string | undefined;
  let contextTokens: number | undefined;
  for (const record of transcriptRecords(lines)) {
    if (record.isSidechain === true) continue;
    if (record.type !== "assistant") continue;
    const message = asRecord(record.message);
    if (!message) continue;
    const usage = asRecord(message.usage);
    if (usage) {
      const total = claudeUsageContextTokens(usage);
      if (total > 0) contextTokens = total;
    }
    const content = message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const item = asRecord(block);
      if (!item) continue;
      if (item.type === "tool_use" && item.name === "TodoWrite") {
        const parsed = extractTodos(item.input);
        if (parsed) latestTodos = parsed;
      } else if (item.type === "text" && typeof item.text === "string") {
        const folded = foldSingleLine(item.text, MAX_NOTE_CHARS);
        if (folded) latestNote = folded;
      }
    }
  }
  const todos = latestTodos ?? [];
  const allOpenTodos = todos.filter((todo) => todo.status !== "completed");
  return {
    transcriptPath,
    openTodos: allOpenTodos.slice(0, MAX_OPEN_TODOS),
    openTodoCount: allOpenTodos.length,
    totalTodos: todos.length,
    ...(latestNote ? { latestNote } : {}),
    ...(contextTokens !== undefined ? { contextTokens } : {}),
  };
}
