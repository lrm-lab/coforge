import { truncateCodePoints, truncateCodePointsWithEllipsis } from "@lrm/coforge-sdk/internal";
import { collapseWhitespace } from "#src/inline-text";
import { asRecord } from "#src/json-record";
import { CHARS_PER_TOKEN, estimateTokens } from "#src/token-estimate";
import type { CodexHistoryHost } from "./host";
import {
  CODEX_BRIEFING_TAIL_BYTES,
  findCodexRollout,
  readRolloutTailLines,
  rolloutRecords,
  type CodexRolloutRecord,
} from "./session-rollout";

/**
 * The briefing a recycled Codex session opens with, in the same shape as Claude's constructed
 * panel: recent messages, then recent actions, inside the caller's token budget. The source is
 * the rollout's `response_item` records (openai/codex `ResponseItem`, 2026-10-28). Any failure
 * means no briefing, and the wake still starts a fresh session.
 */

const MIN_ACTIONS = 5;
const RECENT_ACTIONS = 12;
const RECENT_MESSAGES = 25;
const MESSAGE_MAX_TOKENS = 2_000;
const ELIDE_SCAN_CHARS = 4_096;
const TRUNCATED = "\n[… truncated]";
const MESSAGE_TRUNCATED = "\n[… truncated — read the channel for the rest]";
/** Same credential-path rule as the Claude briefing. A match keeps the call and drops its output. */
const SENSITIVE_PATH_RE =
  /(secret|credential|password|token|\.key$|\.pem$|\.env(\.[^/]+)?$|(^|\/)\.(npmrc|netrc|pgpass|pypirc)$|(^|\/)\.(ssh|aws|gnupg|kube)\/|(^|\/)id_(rsa|dsa|ecdsa|ed25519)|\.(p12|pfx|jks|keystore)$)/i;
const FAIL_RE =
  /(exit code [1-9]|error|Error|ERROR|not found|No such file|failed|Failed|Traceback|refus)/;

type Environment = Readonly<Record<string, string>> | undefined;

type Action = {
  id?: string;
  tool: string;
  input: Record<string, unknown>;
  result: string;
  sensitive: boolean;
  ok: boolean;
};

function messageBody(text: string): string {
  return estimateTokens(text.length) <= MESSAGE_MAX_TOKENS
    ? text
    : `${truncateCodePoints(text, MESSAGE_MAX_TOKENS * CHARS_PER_TOKEN)}${MESSAGE_TRUNCATED}`;
}

function clock(timestampMs: number): string {
  return new Date(timestampMs)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, "Z");
}

function elide(text: string, limit: number): string {
  const flat = collapseWhitespace(truncateCodePoints(text, ELIDE_SCAN_CHARS));
  return flat.length <= limit ? flat : truncateCodePointsWithEllipsis(flat, Math.max(0, limit - 1));
}

function fit(text: string, budgetTokens: number): string {
  const limit = budgetTokens * CHARS_PER_TOKEN;
  if (text.length <= limit) return text;
  return truncateCodePoints(text, Math.max(0, limit - TRUNCATED.length)) + TRUNCATED;
}

function contentText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map(asRecord)
    .filter(
      (block) =>
        (block?.type === "input_text" || block?.type === "output_text") &&
        typeof block.text === "string",
    )
    .map((block) => block!.text as string)
    .join("\n");
}

function outputText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value))
    return contentText(value) || value.map((item) => outputText(item)).join("\n");
  const record = asRecord(value);
  if (!record) return "";
  if (typeof record.content === "string") return record.content;
  return contentText(record.content);
}

function stringsOf(value: unknown, depth: number, out: string[]): void {
  if (depth > 6) return;
  if (typeof value === "string") {
    out.push(value.slice(0, ELIDE_SCAN_CHARS));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) stringsOf(item, depth + 1, out);
    return;
  }
  const record = asRecord(value);
  if (!record) return;
  for (const item of Object.values(record)) stringsOf(item, depth + 1, out);
}

function sensitive(input: Record<string, unknown>): boolean {
  const strings: string[] = [];
  stringsOf(input, 0, strings);
  return strings.some((value) => SENSITIVE_PATH_RE.test(value));
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || !value) return {};
  try {
    const parsed = asRecord(JSON.parse(value));
    return parsed ?? { arguments: value.slice(0, ELIDE_SCAN_CHARS) };
  } catch {
    return { arguments: value.slice(0, ELIDE_SCAN_CHARS) };
  }
}

function shellFields(action: unknown): { command: string[]; directory: string } {
  const record = asRecord(action);
  if (record?.type !== "exec" || !Array.isArray(record.command))
    return { command: [], directory: "" };
  return {
    command: record.command.filter((part) => typeof part === "string"),
    directory: typeof record.working_directory === "string" ? record.working_directory : "",
  };
}

/** Claude's path rule, applied to a whole argument and to each path inside a shell script. */
function pathIsSensitive(value: string): boolean {
  if (SENSITIVE_PATH_RE.test(value)) return true;
  const parts = value.match(/[^\s;&|]+/g);
  return parts !== null && parts.some((part) => part !== value && SENSITIVE_PATH_RE.test(part));
}

function shellIsSensitive(command: readonly string[], directory: string): boolean {
  const directoryWithSlash =
    directory.length > 0 && !directory.endsWith("/") ? `${directory}/` : "";
  return [...command, directory, directoryWithSlash].some(
    (value) => value.length > 0 && pathIsSensitive(value),
  );
}

function actionOf(payload: Record<string, unknown>): Action | undefined {
  const kind = payload.type;
  const callId = typeof payload.call_id === "string" ? payload.call_id : undefined;
  if (kind === "function_call" && typeof payload.name === "string") {
    const input = parseArguments(payload.arguments);
    return {
      id: callId,
      tool: payload.name,
      input,
      result: "",
      sensitive: sensitive(input),
      ok: true,
    };
  }
  if (kind === "custom_tool_call" && typeof payload.name === "string") {
    const input = { input: typeof payload.input === "string" ? payload.input : "" };
    return {
      id: callId,
      tool: payload.name,
      input,
      result: "",
      sensitive: sensitive(input),
      ok: true,
    };
  }
  if (kind === "local_shell_call") {
    const shell = shellFields(payload.action);
    const input: Record<string, unknown> = { command: shell.command.join(" ") };
    if (shell.directory) input.working_directory = shell.directory;
    return {
      id: callId,
      tool: "shell",
      input,
      result: "",
      sensitive: shellIsSensitive(shell.command, shell.directory),
      ok: true,
    };
  }
  if (kind === "web_search_call") {
    const action = asRecord(payload.action);
    const query = typeof action?.query === "string" ? action.query : "";
    const input = { query };
    return { tool: "web_search", input, result: "", sensitive: sensitive(input), ok: true };
  }
  return;
}

function collect(records: readonly CodexRolloutRecord[]): {
  messages: string[];
  actions: Action[];
} {
  const messages: string[] = [];
  const actions: Action[] = [];
  const byId = new Map<string, Action>();
  for (const record of records) {
    if (record.type !== "response_item" || !record.payload) continue;
    const payload = record.payload;
    if (payload.type === "message" || payload.type === "agent_message") {
      const text = contentText(payload.content);
      const role = payload.type === "agent_message" ? "assistant" : payload.role;
      if ((role === "user" || role === "assistant") && text)
        messages.push(`[${clock(record.timestampMs)}] ${role}: ${messageBody(text)}`);
      continue;
    }
    if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
      const id = typeof payload.call_id === "string" ? payload.call_id : undefined;
      const action = id ? byId.get(id) : undefined;
      if (!action || action.result) continue;
      action.result = outputText(payload.output);
      action.ok = !FAIL_RE.test(action.result.slice(0, 400));
      continue;
    }
    const action = actionOf(payload);
    if (!action) continue;
    actions.push(action);
    if (action.id) byId.set(action.id, action);
  }
  return { messages, actions };
}

function actionLine(action: Action, index: number): string {
  const parts = Object.entries(action.input).map(
    ([key, value]) =>
      `${key}=${elide(typeof value === "string" ? value : JSON.stringify(value ?? ""), 44)}`,
  );
  const result = !action.result
    ? ""
    : action.sensitive
      ? " → [withheld: sensitive path]"
      : ` → ${elide(action.result, 60)}`;
  return `${String(index).padStart(3, " ")}${action.ok ? "  " : " !"} ${action.tool}(${parts.join(" ")})${result}`;
}

function within(lines: readonly string[], budgetTokens: number): string {
  const kept = [...lines];
  while (kept.length > 1 && estimateTokens(kept.join("\n").length) > budgetTokens) kept.shift();
  return fit(kept.join("\n"), budgetTokens);
}

/** The panel for these records, or `undefined` when the session did too little to brief. */
export function formatCodexRecycleBriefing(
  records: readonly CodexRolloutRecord[],
  budgetTokens: number,
): string | undefined {
  if (!(budgetTokens > 0)) return;
  const { messages, actions } = collect(records);
  if (actions.length < MIN_ACTIONS) return;
  const messageBudget = Math.max(1, Math.floor(budgetTokens / 2));
  const messageSection =
    messages.length === 0
      ? ""
      : [
          '<recent-messages order="newest last" note="recent tail only; older messages not shown">',
          within(messages.slice(-RECENT_MESSAGES), messageBudget),
          "</recent-messages>",
        ].join("\n");
  const tail = actions.slice(-RECENT_ACTIONS);
  const actionSection = [
    `<recent-actions span="${tail.length} of ${actions.length}" order="oldest first">`,
    ...tail.map((action, index) => actionLine(action, actions.length - tail.length + index)),
    "</recent-actions>",
  ].join("\n");
  const panel = [messageSection, actionSection]
    .filter((section) => section.length > 0)
    .join("\n\n");
  return fit(panel, budgetTokens);
}

/** `CodeAgentProvider.readRecycleBriefing` for Codex. */
export async function readCodexRecycleBriefing(
  options: {
    sessionId: string;
    workingDirectory: string;
    budgetTokens: number;
    envVars?: Environment;
  },
  host: CodexHistoryHost,
): Promise<string | undefined> {
  if (!(options.budgetTokens > 0)) return;
  try {
    const path = await findCodexRollout(options.sessionId, options.envVars, host);
    if (!path) return;
    const lines = await readRolloutTailLines(path, CODEX_BRIEFING_TAIL_BYTES, host);
    if (!lines) return;
    return formatCodexRecycleBriefing(rolloutRecords(lines), options.budgetTokens);
  } catch {
    return;
  }
}
