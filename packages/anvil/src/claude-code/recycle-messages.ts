import type { ClaudeHistoryHost } from "./host";
import { asRecord } from "#src/json-record";
import { cliClock, toolResultText } from "./recycle-actions";
import { transcriptRecords } from "./session-transcript";
import { readTailLines } from "#src/transcript-tail";
import { frameUntrustedText } from "@lrm/coforge-sdk/internal";
import { COFORGE_MESSAGE_HEADER } from "#src/briefing-text";

/**
 * The CoForge messages a Claude session saw and sent, recovered from its transcript for the
 * recycle briefing. Ported from the reference Computer's `collectRecentMessages`, reshaped for the
 * `coforge` CLI. Inbound: a tool result of `coforge message check|read|resolve` holds lines
 * `[target=#coforge:01a16774-5cc3 msg=01a16779-a316 time=2026-10-23 06:36:27Z type=human] @user: body`
 * (`read` prints `[1/5 msg=<full id> time=... type=...] @user: body`), ended by
 * `No more new inbox messages.` (`No more new messages.` in older output) or a blank line. Outbound: a Bash `tool_use` running
 * `coforge message send --target '<target>'` with the body as a heredoc on stdin; its result says
 * `Message sent to ...`, or a held draft that `--send-draft` sends later.
 */

export type RecentMessage = {
  raw: string;
  /** The first 13 characters of the message id (`xxxxxxxx-xxxx`), shared by `check` and `read`. */
  msgId: string | null;
  ts: string | null;
  self: boolean;
};

const MESSAGE_SCAN_TAIL_BYTES = 16 * 1024 * 1024;
const SEND_COMMAND_RE = /\bcoforge\s+message\s+send\b/;
/** One shell word with no expansion, redirection or composition in it. */
const WORD = String.raw`(?:'[^'\n]*'|"[^"$\x60\\\n]*"|[^\s;&|\x60$()<>'"]+)`;
/** A `WORD` ending where a word ends. */
const PLAIN_WORD = String.raw`${WORD}(?=\s|$|\|)`;
/** `cd <dir>;` or `cd <dir> &&` before the call, spaced or not: it prints nothing when it
 * succeeds. */
const CD_PREFIX = new RegExp(String.raw`^\s*cd\s+${WORD}\s*(?:;|&&)\s*`);
const READ_CALL = new RegExp(
  String.raw`^coforge\s+message\s+(?:check|read|resolve)(?=\s|$)(?:[ \t]+${PLAIN_WORD})*`,
);
/** `| head -60`, `| tail -n 20`, `| cut -c1-1500`: a filter of the call's own output. Only flags
 * and numbers: `head notes.txt` would print the file instead. */
const FILTER_STAGE = /^\s*\|\s*(?:head|tail|cut)(?:[ \t]+(?:-[\w=,.-]+|\d+)(?=\s|$|\|))*/;

/**
 * Whether everything `command` prints is `coforge message check|read|resolve`'s own output: that
 * one call, optionally after a `cd`, with `2>&1` and `head`/`tail`/`cut` filters at most. Anything
 * chained, substituted, redirected from a file or piped through another program (a `cat`, a `grep`
 * naming the command) could print text someone else wrote, so it is never read as messages.
 */
function readsOnlyMessageOutput(command: string): boolean {
  let rest = command.replace(CD_PREFIX, "");
  const call = READ_CALL.exec(rest);
  if (!call) return false;
  rest = rest.slice(call[0].length).replace(/^\s*2>&1/, "");
  for (let stage = FILTER_STAGE.exec(rest); stage; stage = FILTER_STAGE.exec(rest))
    rest = rest.slice(stage[0].length);
  return rest.trim() === "";
}
const MSG_ATTR_RE = /\bmsg=([\w-]+)/;
const TIME_ATTR_RE = /\btime=([0-9T:\- ]+Z?)/;
const TARGET_ARG_RE = /--target[=\s]+(?:"([^"]+)"|'([^']+)'|(\S+))/;
const HEREDOC_HEADER_RE = /<<-?[ \t]*['"]?([A-Za-z_]\w*)['"]?[^\n]*\n/;
/** System notices that are not conversation. */
const EPHEMERAL_SYSTEM_RE = /@system[^\n]*(reminder|Next iteration|catch-?up)|^\[system reminder/im;
const MAX_CHUNK_LINES = 80;
/** A message line is read this far: longer ones are cut to a few thousand tokens anyway. */
const MAX_LINE_CHARS = 16 * 1024;
/** A send command is read this far (the heredoc body included). */
const MAX_COMMAND_CHARS = 64 * 1024;
/** `--target` comes right after the command name. */
const TARGET_SCAN_CHARS = 2 * 1024;

function shortId(id: string | undefined): string | null {
  return id ? id.slice(0, 13) : null;
}

/** The message lines of one `check`/`read` output. */
function parseMessageChunks(text: string): RecentMessage[] {
  const out: RecentMessage[] = [];
  let current: string[] | null = null;
  const finalize = () => {
    if (!current) return;
    let raw = current.join("\n").trimEnd();
    const end = /No more new (?:inbox )?messages\.$/.exec(raw);
    if (end) raw = raw.slice(0, end.index).trimEnd();
    if (raw.length > 0 && !EPHEMERAL_SYSTEM_RE.test(raw.slice(0, MAX_LINE_CHARS))) {
      out.push({
        raw,
        msgId: shortId(MSG_ATTR_RE.exec(current[0]!)?.[1]),
        ts: TIME_ATTR_RE.exec(current[0]!)?.[1]?.trim() ?? null,
        self: false,
      });
    }
    current = null;
  };
  for (const fullLine of text.split("\n")) {
    const line = fullLine.slice(0, MAX_LINE_CHARS);
    if (COFORGE_MESSAGE_HEADER.test(line)) {
      finalize();
      current = [line];
    } else if (/^No more new (?:inbox )?messages\.?$/.test(line.trim())) {
      finalize();
    } else if (current && current.length < MAX_CHUNK_LINES && line.trim().length > 0) {
      current.push(line);
    } else if (current) {
      finalize();
    }
  }
  finalize();
  return out;
}

/** `command` (already bounded by the caller) from its `coforge message send` on. */
function sendSegment(command: string): string {
  return command.slice(Math.max(0, command.search(SEND_COMMAND_RE)));
}

function sendTarget(command: string): string | null {
  const match = TARGET_ARG_RE.exec(command.slice(0, TARGET_SCAN_CHARS));
  return match ? (match[1] ?? match[2] ?? match[3] ?? null) : null;
}

/** The text of the first heredoc in `command` (`<<'WORD'` ... `WORD`), or `undefined`. */
function heredocBody(command: string): string | undefined {
  const header = HEREDOC_HEADER_RE.exec(command);
  if (!header) return;
  const from = header.index + header[0].length;
  const marker = `\n${header[1]}`;
  for (let at = command.indexOf(marker, from - 1); at >= 0; at = command.indexOf(marker, at + 1)) {
    const after = command[at + marker.length];
    if (after === undefined || /\s/.test(after)) return command.slice(from, at);
  }
}

/** The message a `coforge message send` command writes: its heredoc body, never a `--send-draft`. */
function parseSentMessage(command: string, ts: string | null): RecentMessage | null {
  const send = sendSegment(command);
  const target = sendTarget(send);
  if (!target || target.includes("$") || /--send-draft\b/.test(send)) return null;
  const body = heredocBody(send)?.trim();
  if (!body) return null;
  const when = cliClock(ts) ?? ts;
  return {
    raw: `[target=${target}${when ? ` time=${when}` : ""}] you sent: ${frameUntrustedText(body)}`,
    msgId: null,
    ts,
    self: true,
  };
}

export async function collectRecentMessages(
  transcriptPath: string,
  max: number,
  host: ClaudeHistoryHost,
): Promise<RecentMessage[]> {
  const lines = await readTailLines(transcriptPath, MESSAGE_SCAN_TAIL_BYTES, host);
  if (!lines) return [];
  const sendAttempts = new Map<
    string,
    { message: RecentMessage | null; target: string | null; reads: boolean }
  >();
  const draftByTarget = new Map<string, RecentMessage>();
  const found: RecentMessage[] = [];
  const handleResult = (id: string | null, text: string) => {
    const attempt = id === null ? undefined : sendAttempts.get(id);
    // Only `coforge message` output holds messages: a file or another tool can print anything.
    if (!attempt) return;
    const delivered = /Message sent/.test(text);
    if (attempt.message) {
      if (delivered) found.push(attempt.message);
      else if (attempt.target) draftByTarget.set(attempt.target, attempt.message);
    } else if (delivered && attempt.target) {
      const draft = draftByTarget.get(attempt.target);
      if (draft) {
        found.push(draft);
        draftByTarget.delete(attempt.target);
      }
    }
    if (attempt.reads) found.push(...parseMessageChunks(text));
  };
  for (const record of transcriptRecords(lines)) {
    const ts = typeof record.timestamp === "string" ? record.timestamp : null;
    const content = asRecord(record.message)?.content;
    if (record.type === "assistant" && Array.isArray(content)) {
      for (const block of content.map(asRecord)) {
        if (block?.type !== "tool_use" || typeof block.id !== "string") continue;
        const rawCommand = asRecord(block.input)?.command;
        if (typeof rawCommand !== "string") continue;
        const command = rawCommand.slice(0, MAX_COMMAND_CHARS);
        const sends = SEND_COMMAND_RE.test(command);
        const reads = readsOnlyMessageOutput(command);
        if (!sends && !reads) continue;
        sendAttempts.set(block.id, {
          message: sends ? parseSentMessage(command, ts) : null,
          target: sends ? sendTarget(sendSegment(command)) : null,
          reads,
        });
      }
    } else if (record.type === "user" && Array.isArray(content)) {
      // A user turn's own text is never read for messages: it may quote anything.
      for (const block of content.map(asRecord))
        if (block?.type === "tool_result")
          handleResult(
            typeof block.tool_use_id === "string" ? block.tool_use_id : null,
            toolResultText(block.content, "\n"),
          );
    }
  }
  const byKey = new Map<string, { message: RecentMessage; order: number }>();
  found.forEach((message, order) => {
    const key = message.msgId ?? `${message.self}|${message.raw.slice(0, 100)}`;
    const existing = byKey.get(key);
    if (!existing) byKey.set(key, { message, order });
    else {
      existing.order = order;
      if (message.raw.length > existing.message.raw.length) existing.message = message;
    }
  });
  const sortValue = (entry: { message: RecentMessage; order: number }) => {
    const ts = entry.message.ts;
    const parsed = ts ? Date.parse(ts.includes("T") ? ts : ts.replace(" ", "T")) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : entry.order;
  };
  return [...byKey.values()]
    .sort((a, b) => sortValue(a) - sortValue(b) || a.order - b.order)
    .slice(-Math.max(0, max))
    .map((entry) => entry.message);
}
