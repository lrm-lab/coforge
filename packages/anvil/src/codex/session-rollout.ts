import { isAbsolute, join } from "node:path";
import { asRecord } from "#src/json-record";
import type { SessionResumeFacts } from "#src/contract";
import type { CodexDirectoryEntry, CodexHistoryHost } from "./host";
import { readTailLines } from "#src/transcript-tail";

export const CODEX_IDLE_RECYCLE_MIN_COLD_GAP_MS = 60 * 60_000;

const FACTS_TAIL_BYTES = 512 * 1024;
export const CODEX_BRIEFING_TAIL_BYTES = 4 * 1024 * 1024;
const MAX_DIRECTORIES = 5_000;
const MAX_DEPTH = 8;
const TIMESTAMP_PREFIX_LENGTH = 19;

type Environment = Readonly<Record<string, string>> | undefined;

export type CodexRolloutRecord = {
  timestampMs: number;
  type: string;
  payload: Record<string, unknown> | undefined;
};

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

function safeThreadId(sessionId: string): boolean {
  return sessionId.length > 0 && sessionId.length <= 200 && /^[A-Za-z0-9-]+$/.test(sessionId);
}

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

function contextUpdate(payload: Record<string, unknown> | undefined): number | null | undefined {
  if (payload?.type !== "token_count") return;
  const info = asRecord(payload.info);
  if (!info) return;
  const last = asRecord(info.last_token_usage);
  const lastInput = nonNegative(last?.input_tokens);
  if (lastInput === undefined) return;
  const lastTotal = nonNegative(last?.total_tokens) ?? 0;
  if (lastInput > 0) return lastTotal > 0 ? lastTotal : null;
  const total = asRecord(info.total_token_usage);
  const totalInput = nonNegative(total?.input_tokens) ?? 0;
  if (lastTotal > 0 && totalInput > 0) return lastTotal;
  const window = nonNegative(total?.total_tokens) ?? 0;
  if (totalInput === 0 && window > 0) return window;
}

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
  let lastContextMissingAtMs: number | undefined;
  for (const record of records) {
    if (record.type !== "event_msg") continue;
    const update = contextUpdate(record.payload);
    if (update === undefined) continue;
    lastContextTokens = update ?? undefined;
    lastContextMissingAtMs = update === null ? record.timestampMs : undefined;
  }
  return {
    lastActivityAtMs: last.timestampMs,
    ...(lastContextTokens !== undefined ? { lastContextTokens } : {}),
    ...(lastContextMissingAtMs !== undefined ? { lastContextMissingAtMs } : {}),
  };
}
