import { join } from "node:path";
import { asRecord } from "#src/json-record";
import {
  localSessionField,
  localSessionIo,
  LocalSessionDeadlineError,
  localSessionSnippet,
  localSessionText,
  readLocalSessionWindows,
  type LocalSessionExcerptOptions,
  type LocalSessionSearchOptions,
  type NativeLocalSession,
  type NativeLocalSessionExcerpt,
  type NativeLocalSessionTurn,
} from "#src/local-session";
import type { CodexHistoryHost } from "./host";
import { codexHomeDirectory, threadIdOfRollout } from "./session-rollout";

const STAMP_LENGTH = 19;
type Candidate = { path: string; name: string; sessionId: string; modifiedAtMs: number };
type Details = NativeLocalSessionExcerpt & { cwd: string; title: string; searchable: string };

function rolloutTimestamp(name: string): number {
  const stamp = name.slice("rollout-".length, "rollout-".length + STAMP_LENGTH);
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})$/.exec(stamp);
  return match ? Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}Z`) : 0;
}

async function candidates(options: LocalSessionSearchOptions, host: CodexHistoryHost) {
  const home = codexHomeDirectory(undefined, host);
  if (!home) return { found: [] as Candidate[], complete: true };
  const queue = [{ path: join(home, "sessions"), depth: 0 }];
  const newest = new Map<string, Candidate>();
  let directories = 0;
  let files = 0;
  let complete = true;
  while (queue.length > 0) {
    if (options.limits.now() >= options.limits.deadlineAtMs) {
      complete = false;
      break;
    }
    const current = queue.shift()!;
    if (++directories > options.limits.maxDirectories) {
      complete = false;
      break;
    }
    let entries;
    try {
      entries = await localSessionIo(host.readDirectoryEntries(current.path), options.limits);
    } catch (error) {
      if (error instanceof LocalSessionDeadlineError) {
        complete = false;
        break;
      }
      continue;
    }
    for (const entry of entries) {
      if (options.limits.now() >= options.limits.deadlineAtMs) {
        complete = false;
        break;
      }
      if (entry.isSymbolicLink()) continue;
      const path = join(current.path, entry.name);
      if (entry.isDirectory()) {
        if (current.depth < 8) queue.push({ path, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      const sessionId = threadIdOfRollout(entry.name);
      if (!sessionId) continue;
      if (++files > options.limits.maxFiles) {
        complete = false;
        break;
      }
      const candidate = {
        path,
        name: entry.name,
        sessionId,
        modifiedAtMs: rolloutTimestamp(entry.name),
      };
      const old = newest.get(sessionId);
      if (!old || candidate.name > old.name) newest.set(sessionId, candidate);
    }
    if (!complete) break;
  }
  return { found: [...newest.values()], complete };
}

function contentText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return localSessionText(
    value
      .map(asRecord)
      .filter(
        (block) =>
          (block?.type === "input_text" || block?.type === "output_text") &&
          typeof block.text === "string",
      )
      .map((block) => block!.text as string)
      .join("\n"),
  );
}

function details(records: readonly unknown[], modifiedAtMs: number): Details | undefined {
  let cwd = "";
  let model = "";
  let initialRequest = "";
  let updatedAtMs = Math.max(0, modifiedAtMs);
  const recentTurns: NativeLocalSessionTurn[] = [];
  for (const value of records) {
    const record = asRecord(value);
    if (!record || typeof record.type !== "string") continue;
    const payload = asRecord(record.payload);
    const timestampMs = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
    if (Number.isFinite(timestampMs)) updatedAtMs = Math.max(updatedAtMs, timestampMs);
    if (record.type === "session_meta" && typeof payload?.cwd === "string" && payload.cwd.trim())
      cwd = localSessionField(payload.cwd, 4_096);
    if (record.type === "turn_context" && typeof payload?.model === "string")
      model = localSessionField(payload.model, 200);
    if (record.type !== "response_item" || payload?.type !== "message") continue;
    const role = payload.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = contentText(payload.content);
    if (!text) continue;
    if (role === "user" && !initialRequest) initialRequest = text;
    recentTurns.push({
      role,
      text: text.slice(0, 8_192),
      timestampMs: Number.isFinite(timestampMs) ? timestampMs : updatedAtMs,
    });
  }
  if (!cwd) return;
  return {
    cwd: localSessionField(cwd, 4_096),
    model,
    title: initialRequest.slice(0, 500),
    updatedAtMs,
    initialRequest: initialRequest.slice(0, 8_192),
    recentTurns: recentTurns.slice(-12),
    searchable: recentTurns.map((turn) => turn.text).join("\n"),
  };
}

async function readDetails(
  candidate: Candidate,
  options: LocalSessionSearchOptions | LocalSessionExcerptOptions,
  host: CodexHistoryHost,
  budget: { bytes: number },
) {
  const read = await readLocalSessionWindows(candidate.path, options.limits, host, budget);
  if (!read) return;
  const parsed = details(read.records, candidate.modifiedAtMs);
  return parsed ? { parsed, complete: read.complete } : undefined;
}

export async function searchCodexLocalSessions(
  options: LocalSessionSearchOptions,
  host: CodexHistoryHost,
) {
  const discovered = await candidates(options, host);
  const query = options.query.trim().toLocaleLowerCase();
  const budget = { bytes: options.limits.maxContentBytes };
  const sessions: NativeLocalSession[] = [];
  let contentSearchComplete = true;
  let examined = 0;
  for (const candidate of discovered.found.sort((a, b) => b.modifiedAtMs - a.modifiedAtMs)) {
    if (sessions.length >= options.limits.maxResults) {
      if (query) contentSearchComplete = false;
      break;
    }
    examined += 1;
    if (options.limits.now() >= options.limits.deadlineAtMs || budget.bytes <= 0) {
      if (query) contentSearchComplete = false;
      break;
    }
    let read;
    try {
      read = await readDetails(candidate, options, host, budget);
    } catch (error) {
      if (error instanceof LocalSessionDeadlineError) {
        contentSearchComplete = false;
        break;
      }
      throw error;
    }
    if (!read) {
      if (query) contentSearchComplete = false;
      continue;
    }
    const { parsed } = read;
    let matchKind: NativeLocalSession["matchKind"] = "recent";
    if (query) {
      if (candidate.sessionId.toLocaleLowerCase().includes(query)) matchKind = "id";
      else if (parsed.cwd.toLocaleLowerCase().includes(query)) matchKind = "cwd";
      else if (`${parsed.title}\n${parsed.searchable}`.toLocaleLowerCase().includes(query))
        matchKind = "content";
      else {
        if (!read.complete) contentSearchComplete = false;
        continue;
      }
      if (!read.complete && matchKind !== "id" && matchKind !== "cwd")
        contentSearchComplete = false;
    }
    sessions.push({
      sessionId: candidate.sessionId,
      cwd: parsed.cwd,
      model: parsed.model,
      title: parsed.title,
      updatedAtMs: parsed.updatedAtMs,
      matchKind,
      snippet: matchKind === "content" ? localSessionSnippet(parsed.searchable, query) : "",
    });
  }
  return {
    sessions: sessions.sort((a, b) => b.updatedAtMs - a.updatedAtMs),
    scanComplete: discovered.complete && examined === discovered.found.length,
    contentSearchComplete: query ? contentSearchComplete : true,
  };
}

export async function readCodexLocalSessionExcerpt(
  options: LocalSessionExcerptOptions,
  host: CodexHistoryHost,
): Promise<NativeLocalSessionExcerpt | undefined> {
  const discovered = await candidates({ query: "", limits: options.limits }, host);
  const candidate = discovered.found.find((item) => item.sessionId === options.sessionId);
  if (!candidate) return;
  const read = await readDetails(candidate, options, host, {
    bytes: options.limits.maxContentBytes,
  });
  return read?.parsed.cwd === options.cwd
    ? {
        model: read.parsed.model,
        updatedAtMs: read.parsed.updatedAtMs,
        initialRequest: read.parsed.initialRequest,
        recentTurns: read.parsed.recentTurns,
      }
    : undefined;
}
