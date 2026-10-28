import { isAbsolute, join } from "node:path";
import { asRecord } from "#src/json-record";
import type { SessionResumeFacts } from "#src/contract";
import type { CodexDirectoryEntry, CodexHistoryHost } from "./host";
import { readTailLines } from "#src/transcript-tail";

/**
 * Codex's own rollout, read for the idle-recycle decision and briefing.
 *
 * `CODEX_HOME` is the documented session root. The JSONL layout is not a public contract
 * (openai/codex `RolloutLine` / `RolloutItemWire` on main, 2026-10-28; OpenAI treats rollout
 * files as internal). Re-check it when the Codex version floor moves.
 *
 * A line is `{ timestamp, type, payload }` (`ordinal` ignored). A session file lives under
 * `$CODEX_HOME/sessions` and is named `rollout-<UTC second>-<threadId>.jsonl`, or the same name
 * with `_<rolloutId>` after the thread id when a revert minted a new rollout. The newest
 * filename timestamp wins. An unreadable file or a line that does not parse is skipped; no
 * usable record means the caller resumes.
 */

/** Prompt-cache lifetime Codex is counted on. OpenAI's default cache is at least 30 minutes. */
export const CODEX_IDLE_RECYCLE_MIN_COLD_GAP_MS = 30 * 60_000;

/** The tail read for resume facts: the last record and the latest token count sit at the end. */
const FACTS_TAIL_BYTES = 512 * 1024;
/** The tail read for a briefing. Older turns outside this window are not carried over. */
export const CODEX_BRIEFING_TAIL_BYTES = 4 * 1024 * 1024;
const MAX_DIRECTORIES = 5_000;
/** `sessions/YYYY/MM/DD` is three levels; a few more leaves room for a layout change. */
const MAX_DEPTH = 8;
const TIMESTAMP_PREFIX_LENGTH = 19;

type Environment = Readonly<Record<string, string>> | undefined;

export type CodexRolloutRecord = {
  timestampMs: number;
  type: string;
  payload: Record<string, unknown> | undefined;
};

/** Absolute `CODEX_HOME` from the Agent, else the host, else `~/.codex`. A relative value is undecidable. */
export function codexHomeDirectory(
  envVars: Environment,
  host: CodexHistoryHost,
): string | undefined {
  const configured = envVars?.CODEX_HOME?.trim();
  if (configured) return isAbsolute(configured) ? configured : undefined;
  const hostHome = host.readHostEnvironment("CODEX_HOME")?.trim();
  if (hostHome) return isAbsolute(hostHome) ? hostHome : undefined;
  const home = (
    envVars?.HOME ??
    envVars?.USERPROFILE ??
    host.readHostEnvironment("HOME") ??
    host.readHostEnvironment("USERPROFILE")
  )?.trim();
  return join(home || host.homeDirectory(), ".codex");
}

/** Thread ids are UUIDs. Anything else could escape the sessions directory. */
function safeThreadId(sessionId: string): boolean {
  return sessionId.length > 0 && sessionId.length <= 200 && /^[A-Za-z0-9-]+$/.test(sessionId);
}

/** The thread id encoded in a rollout basename, or `undefined` when the name is not one. */
export function threadIdOfRollout(name: string): string | undefined {
  if (!name.startsWith("rollout-") || !name.endsWith(".jsonl")) return;
  const core = name.slice("rollout-".length, -".jsonl".length);
  if (core.length < TIMESTAMP_PREFIX_LENGTH + 2 || core[TIMESTAMP_PREFIX_LENGTH] !== "-") return;
  const threadId = core.slice(TIMESTAMP_PREFIX_LENGTH + 1).split("_")[0];
  return threadId && safeThreadId(threadId) ? threadId : undefined;
}

function filenameStamp(name: string): string {
  return name.slice("rollout-".length, "rollout-".length + TIMESTAMP_PREFIX_LENGTH);
}

/**
 * The rollout file for `sessionId`, or `undefined` when the store has none. A symlink is never
 * followed. Among several rollouts of one thread (a revert writes another file), the newest
 * filename timestamp wins.
 */
export async function findCodexRollout(
  sessionId: string,
  envVars: Environment,
  host: CodexHistoryHost,
): Promise<string | undefined> {
  if (!safeThreadId(sessionId)) return;
  const home = codexHomeDirectory(envVars, host);
  if (!home) return;
  const queue: Array<{ path: string; depth: number }> = [
    { path: join(home, "sessions"), depth: 0 },
  ];
  let best: { path: string; stamp: string; name: string } | undefined;
  let seen = 0;
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || ++seen > MAX_DIRECTORIES) break;
    let entries: readonly CodexDirectoryEntry[];
    try {
      entries = await host.readDirectoryEntries(current.path);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = join(current.path, entry.name);
      if (entry.isDirectory()) {
        if (current.depth < MAX_DEPTH) queue.push({ path, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile() || threadIdOfRollout(entry.name) !== sessionId) continue;
      const stamp = filenameStamp(entry.name);
      if (!best || stamp > best.stamp || (stamp === best.stamp && entry.name > best.name))
        best = { path, stamp, name: entry.name };
    }
  }
  return best?.path;
}

/** Parsed rollout records, in file order. A line without a timestamp or a `type` is skipped. */
export function rolloutRecords(lines: readonly string[]): CodexRolloutRecord[] {
  const records: CodexRolloutRecord[] = [];
  for (const line of lines) {
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const record = asRecord(parsed);
    if (!record || typeof record.timestamp !== "string" || typeof record.type !== "string")
      continue;
    const timestampMs = Date.parse(record.timestamp);
    if (!Number.isFinite(timestampMs)) continue;
    records.push({ timestampMs, type: record.type, payload: asRecord(record.payload) });
  }
  return records;
}

function nonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * The context a `token_count` reports. Codex persists a synthetic `input_tokens: 0` after
 * compaction (the estimate is `last_token_usage.total_tokens`) and when the context window is
 * full (`total_token_usage.total_tokens` is the window, both input fields are 0). A bare 0 does
 * not replace an earlier real count: that would make a full session look small and be resumed.
 */
function contextSample(
  payload: Record<string, unknown> | undefined,
): { tokens: number } | { keep: true } | undefined {
  if (payload?.type !== "token_count") return;
  const info = asRecord(payload.info);
  if (!info) return;
  const last = asRecord(info.last_token_usage);
  const lastInput = nonNegative(last?.input_tokens);
  if (lastInput === undefined) return;
  if (lastInput > 0) return { tokens: lastInput };
  const total = asRecord(info.total_token_usage);
  const lastTotal = nonNegative(last?.total_tokens) ?? 0;
  const totalInput = nonNegative(total?.input_tokens) ?? 0;
  if (lastTotal > 0 && totalInput > 0) return { tokens: lastTotal };
  const window = nonNegative(total?.total_tokens) ?? 0;
  if (totalInput === 0 && window > 0) return { tokens: window };
  return { keep: true };
}

/**
 * Last-record timestamp, and the context of the last `event_msg` / `token_count` that carries a
 * real usage sample. A rate-limit refresh, or a synthetic zero with nothing else to read, does
 * not replace it. `undefined` when the rollout is missing or has no record.
 */
export async function readCodexSessionResumeFacts(
  options: { sessionId: string; envVars?: Environment },
  host: CodexHistoryHost,
): Promise<SessionResumeFacts | undefined> {
  const path = await findCodexRollout(options.sessionId, options.envVars, host);
  if (!path) return;
  const lines = await readTailLines(path, FACTS_TAIL_BYTES, host);
  if (!lines) return;
  const records = rolloutRecords(lines);
  const last = records.at(-1);
  if (!last) return;
  let lastContextTokens: number | undefined;
  for (const record of records) {
    if (record.type !== "event_msg") continue;
    const sample = contextSample(record.payload);
    if (!sample || "keep" in sample) continue;
    lastContextTokens = sample.tokens;
  }
  return {
    lastActivityAtMs: last.timestampMs,
    ...(lastContextTokens !== undefined ? { lastContextTokens } : {}),
  };
}
