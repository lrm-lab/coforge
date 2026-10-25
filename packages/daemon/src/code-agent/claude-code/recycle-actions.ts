import { truncateCodePoints, truncateCodePointsWithEllipsis } from "@lrm/coforge-sdk/internal";
import { collapseWhitespace } from "#src/code-agent/agent-instructions";
import { asRecord } from "@lrm/coforge-anvil";
import { readTranscriptTailLines, transcriptRecords } from "./session-transcript";

/**
 * The tool calls of a Claude transcript, for the recycle briefing. Ported from the reference
 * Computer's wake briefing panel (Raft 1.0.51 `parseTranscriptActions`, `hotObjects`). Record
 * shapes: see `session-transcript.ts` (UNDOCUMENTED, observed with Claude Code 2.1.309 on
 * 2026-10-23): an `assistant` record's `message.content` holds `tool_use` blocks (`id`, `name`,
 * `input`); the following `user` record's `tool_result` blocks (`tool_use_id`, `content`,
 * `is_error`) answer them.
 */

export type TranscriptAction = {
  /** The call's index among the tool calls in the scanned window. */
  i: number;
  tool: string;
  input: Record<string, unknown>;
  result: string;
  ok: boolean;
  mutating: boolean;
  ts: string | null;
};

/** Raft's terms (secret, credential, password, token, .key, .pem) plus dotenv, package-registry and
 * network credential files, ssh/aws/gnupg/kube directories, private keys and key stores. */
export const SENSITIVE_PATH_RE =
  /(secret|credential|password|token|\.key$|\.pem$|\.env(\.[^/]+)?$|(^|\/)\.(npmrc|netrc|pgpass|pypirc)$|(^|\/)\.(ssh|aws|gnupg|kube)\/|(^|\/)id_(rsa|dsa|ecdsa|ed25519)|\.(p12|pfx|jks|keystore)$)/i;

/** The transcript tail scanned for actions. */
const ACTIONS_TAIL_BYTES = 4 * 1024 * 1024;
const FAIL_RE =
  /(exit code [1-9]|error|Error|ERROR|not found|No such file|failed|Failed|Traceback|refus)/;
const MUTATING_RE = new RegExp(
  "(^|[;&|]\\s*)(rm|mv|cp|mkdir|touch|sed\\s+-i|tee|git\\s+(commit|add|checkout|stash|reset|push)|npm\\s+(i|install|run)|pnpm\\s+(i|install|add|run)|pip\\s+install|docker\\s+(run|rm|build)|cargo\\s+|make\\b|chmod|ln\\s|coforge\\s+(message\\s+(send|react)|task\\s+(claim|create|update|convert)))|>>?\\s*\\S",
);

/** A command is scanned for paths and mutations only this far: the rest of a huge one is noise. */
const MAX_SCANNED_COMMAND_CHARS = 8 * 1024;
/** No real path is longer (PATH_MAX is 4096). */
const MAX_PATH_CHARS = 4096;
/** `elide` looks at this much of its input; every limit it is given is far below. */
const ELIDE_SCAN_CHARS = 4096;

function elide(text: string, limit: number): string {
  const flat = collapseWhitespace(truncateCodePoints(text || "", ELIDE_SCAN_CHARS));
  return flat.length <= limit ? flat : truncateCodePointsWithEllipsis(flat, Math.max(0, limit - 1));
}

/** The text of a `tool_result` `content` (a string, or text blocks joined by `separator`). */
export function toolResultText(content: unknown, separator: string): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => String(asRecord(part)?.text ?? "")).join(separator);
}

/** `2026-10-23 06:36:27Z`, the clock the `coforge` CLI prints; `null` for a missing or bad timestamp. */
export function cliClock(ts: string | null): string | null {
  if (!ts || !Number.isFinite(Date.parse(ts))) return null;
  return new Date(ts)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, "Z");
}

export async function readTranscriptActions(transcriptPath: string): Promise<TranscriptAction[]> {
  const lines = await readTranscriptTailLines(transcriptPath, ACTIONS_TAIL_BYTES);
  if (!lines) return [];
  const calls = new Map<
    string,
    { tool: string; input: Record<string, unknown>; ts: string | null }
  >();
  const results = new Map<string, { text: string; isError: boolean }>();
  for (const record of transcriptRecords(lines)) {
    if (record.isSidechain === true) continue;
    const content = asRecord(record.message)?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content.map(asRecord)) {
      if (!block) continue;
      if (
        record.type === "assistant" &&
        block.type === "tool_use" &&
        typeof block.id === "string"
      ) {
        calls.set(block.id, {
          tool: typeof block.name === "string" ? block.name : "?",
          input: asRecord(block.input) ?? {},
          ts: typeof record.timestamp === "string" ? record.timestamp : null,
        });
      } else if (
        record.type === "user" &&
        block.type === "tool_result" &&
        typeof block.tool_use_id === "string"
      ) {
        results.set(block.tool_use_id, {
          text: toolResultText(block.content, " "),
          isError: block.is_error === true,
        });
      }
    }
  }
  const actions: TranscriptAction[] = [];
  let i = 0;
  for (const [id, call] of calls) {
    const result = results.get(id) ?? { text: "", isError: false };
    const command = scannedCommand(call.input);
    actions.push({
      i,
      ...call,
      result: result.text,
      ok: !(result.isError || FAIL_RE.test(result.text.slice(0, 400))),
      mutating: call.tool === "Edit" || call.tool === "Write" || MUTATING_RE.test(command),
    });
    i += 1;
  }
  return actions;
}

/** The `command` input of a tool call, cut to what the pattern scans read. */
function scannedCommand(input: Record<string, unknown>): string {
  return typeof input.command === "string" ? input.command.slice(0, MAX_SCANNED_COMMAND_CHARS) : "";
}

function callForm(action: TranscriptAction, valueWidth = 44): string {
  const parts = Object.entries(action.input)
    .filter(([key]) => key !== "description")
    .map(
      ([key, value]) =>
        `${key}=${elide(typeof value === "string" ? value : JSON.stringify(value ?? ""), valueWidth)}`,
    );
  return `${action.tool}(${parts.join(" ")})`;
}

/** One line of the recent-actions tail: index, `!` failed / `*` mutating, time, call, result. */
export function actionLine(action: TranscriptAction): string {
  const mark = !action.ok ? " !" : action.mutating ? " *" : "  ";
  // What a call on a credential file returned stays out of the new session's transcript.
  const sensitive = Object.values(action.input).some(
    (value) => typeof value === "string" && SENSITIVE_PATH_RE.test(value),
  );
  const result = !action.result
    ? ""
    : sensitive
      ? " \u2192 [withheld: sensitive path]"
      : ` \u2192 ${elide(action.result, 60)}`;
  const when = cliClock(action.ts);
  return `s${String(action.i).padEnd(5)}${mark} ${when ? `${when} ` : ""}${callForm(action)}${result}`;
}

export type HotObject = {
  /** The path as the transcript wrote it (absolute when any mention was). */
  name: string;
  /** Position of the last action touching it. */
  last: number;
  touches: number;
  /** What the transcript shows of its content: a Read result, or a Write/Edit's new text. */
  content: string | null;
  lastTs: string | null;
};

const PATH_CHARS = /[\w.~@/-]/;
const PATH_EXTENSIONS = new Set(
  "ts js py md json yml yaml toml jsonl sh tsx html css txt lock".split(" "),
);
const EDGE_PUNCTUATION = new Set(",;:'\"()[]");

/** `token` without leading `,;:'"()[]` and trailing `.,;:'"()[]`. Leading dots stay: `./a.ts` and
 * `../a.ts` are relative paths, not `/a.ts`. */
function trimEdges(token: string): string {
  let start = 0;
  let end = token.length;
  while (start < end && EDGE_PUNCTUATION.has(token[start]!)) start += 1;
  while (end > start && (token[end - 1] === "." || EDGE_PUNCTUATION.has(token[end - 1]!))) end -= 1;
  return token.slice(start, end);
}

/** Whether a slash-free `token` ends in `<name>.<known extension>` (a bare file name). */
function isBareFileName(token: string): boolean {
  const dot = token.lastIndexOf(".");
  return dot > 0 && PATH_EXTENSIONS.has(token.slice(dot + 1)) && /[\w-]$/.test(token.slice(0, dot));
}

/**
 * The paths in a command: runs of path characters that hold a slash, or end in a known file
 * extension. One pass over the text, so a huge token costs time in proportion to its length.
 */
function pathsIn(text: string): string[] {
  const found = new Set<string>();
  let start = -1;
  const take = (end: number) => {
    const token = text.slice(start, end);
    start = -1;
    if (token.length > MAX_PATH_CHARS) return;
    const path = trimEdges(token);
    if (path.length < 4 || path.startsWith("http")) return;
    if (path.includes("/") || isBareFileName(path)) found.add(path);
  };
  for (let i = 0; i < text.length; i += 1) {
    if (PATH_CHARS.test(text[i]!)) {
      if (start < 0) start = i;
    } else if (start >= 0) take(i);
  }
  if (start >= 0) take(text.length);
  return [...found];
}

/** The files the actions touched, keyed by their last two path segments. */
export function hotObjects(actions: readonly TranscriptAction[]): HotObject[] {
  const index = new Map<string, HotObject>();
  for (const action of actions) {
    const paths = new Set<string>();
    const filePath = action.input.file_path;
    if (typeof filePath === "string" && filePath.length <= MAX_PATH_CHARS) paths.add(filePath);
    for (const path of pathsIn(scannedCommand(action.input))) paths.add(path);
    let content: string | null = null;
    if (action.tool === "Read") content = action.result;
    else if (action.tool === "Write" && typeof action.input.content === "string")
      content = action.input.content;
    else if (action.tool === "Edit" && typeof action.input.new_string === "string")
      content = action.input.new_string;
    for (const path of paths) {
      const segments = path.split("/").filter(Boolean);
      if (path.startsWith("/dev/") || path.endsWith("/") || !(segments.at(-1) ?? "").includes("."))
        continue;
      const key = segments.length > 1 ? segments.slice(-2).join("/") : (segments[0] ?? path);
      const entry = index.get(key) ?? {
        name: path,
        last: 0,
        touches: 0,
        content: null,
        lastTs: null,
      };
      entry.last = action.i;
      entry.touches += 1;
      entry.lastTs = action.ts;
      if (content) entry.content = content;
      if (path.startsWith("/")) entry.name = path;
      index.set(key, entry);
    }
  }
  return [...index.values()];
}
