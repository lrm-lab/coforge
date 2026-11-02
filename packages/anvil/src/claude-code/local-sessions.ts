import { isAbsolute, join } from "node:path";
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
  type NativeLocalSessionExcerptRead,
  type NativeLocalSessionTurn,
} from "#src/local-session";
import type { ClaudeHistoryHost } from "./host";

const SESSION_FILE = /^([A-Za-z0-9][A-Za-z0-9._-]{0,199})\.jsonl$/;

type Candidate = { path: string; sessionId: string; modifiedAtMs: number };
type Details = NativeLocalSessionExcerpt & { cwd: string; title: string; searchable: string };

function configDirectory(host: ClaudeHistoryHost): string {
  const configured = host.readHostEnvironment("CLAUDE_CONFIG_DIR")?.trim();
  return configured && isAbsolute(configured)
    ? configured
    : join(host.readHostEnvironment("HOME")?.trim() || host.homeDirectory(), ".claude");
}

async function candidates(options: LocalSessionSearchOptions, host: ClaudeHistoryHost) {
  const found: Candidate[] = [];
  let directories = 0;
  let files = 0;
  let complete = true;
  let projects;
  try {
    projects = await localSessionIo(
      host.readDirectoryEntries(join(configDirectory(host), "projects")),
      options.limits,
    );
  } catch (error) {
    return { found, complete: !(error instanceof LocalSessionDeadlineError) };
  }
  for (const project of projects) {
    if (options.limits.now() >= options.limits.deadlineAtMs) {
      complete = false;
      break;
    }
    if (!project.isDirectory()) continue;
    if (++directories > options.limits.maxDirectories) {
      complete = false;
      break;
    }
    const root = join(configDirectory(host), "projects", project.name);
    let entries;
    try {
      entries = await localSessionIo(host.readDirectoryEntries(root), options.limits);
    } catch (error) {
      if (error instanceof LocalSessionDeadlineError) {
        complete = false;
        break;
      }
      continue;
    }
    const selected: Array<{ name: string; sessionId: string }> = [];
    for (const entry of entries) {
      const match = SESSION_FILE.exec(entry.name);
      if (!match) continue;
      if (++files > options.limits.maxFiles) {
        complete = false;
        break;
      }
      selected.push({ name: entry.name, sessionId: match[1]! });
    }
    for (let offset = 0; offset < selected.length; offset += 16) {
      const observed = await Promise.all(
        selected.slice(offset, offset + 16).map(async (entry) => {
          const path = join(root, entry.name);
          try {
            const info = await localSessionIo(host.lstat(path), options.limits);
            return info.isFile()
              ? {
                  candidate: {
                    path,
                    sessionId: entry.sessionId,
                    modifiedAtMs: Number.isFinite(info.mtimeMs) ? Math.max(0, info.mtimeMs) : 0,
                  },
                }
              : {};
          } catch (error) {
            return { deadline: error instanceof LocalSessionDeadlineError };
          }
        }),
      );
      for (const observation of observed) {
        if (observation.candidate) found.push(observation.candidate);
        if (observation.deadline) complete = false;
      }
      if (!complete) break;
    }
    if (!complete) break;
  }
  return { found, complete };
}

function textContent(value: unknown): string {
  if (typeof value === "string") return localSessionText(value);
  if (!Array.isArray(value)) return "";
  return localSessionText(
    value
      .map(asRecord)
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block!.text as string)
      .join("\n"),
  );
}

function details(records: readonly unknown[], modifiedAtMs: number): Details | undefined {
  let cwd = "";
  let model = "";
  let initialRequest = "";
  let updatedAtMs = Math.max(0, Math.floor(modifiedAtMs));
  const recentTurns: NativeLocalSessionTurn[] = [];
  for (const value of records) {
    const record = asRecord(value);
    if (!record || record.isSidechain === true) continue;
    if (typeof record.cwd === "string" && record.cwd.trim())
      cwd = localSessionField(record.cwd, 4_096);
    const timestampMs = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
    if (Number.isFinite(timestampMs)) updatedAtMs = Math.max(updatedAtMs, timestampMs);
    const message = asRecord(record.message);
    const role = message?.role ?? record.type;
    if (role !== "user" && role !== "assistant") continue;
    if (role === "assistant" && typeof message?.model === "string")
      model = localSessionField(message.model, 200);
    const text = textContent(message?.content);
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
  host: ClaudeHistoryHost,
  budget: { bytes: number },
) {
  const read = await readLocalSessionWindows(candidate.path, options.limits, host, budget);
  if (!read) return;
  const parsed = details(read.records, candidate.modifiedAtMs);
  return parsed ? { parsed, complete: read.complete } : undefined;
}

export async function searchClaudeLocalSessions(
  options: LocalSessionSearchOptions,
  host: ClaudeHistoryHost,
) {
  const discovered = await candidates(options, host);
  const query = options.query.trim().toLocaleLowerCase();
  const budget = { bytes: options.limits.maxContentBytes };
  const sessions: NativeLocalSession[] = [];
  let contentSearchComplete = true;
  let hydrationComplete = true;
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
        hydrationComplete = false;
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
    scanComplete: discovered.complete && hydrationComplete && examined === discovered.found.length,
    contentSearchComplete: query ? contentSearchComplete : true,
  };
}

export async function readClaudeLocalSessionExcerpt(
  options: LocalSessionExcerptOptions,
  host: ClaudeHistoryHost,
): Promise<NativeLocalSessionExcerptRead> {
  const discovered = await candidates({ query: "", limits: options.limits }, host);
  const candidate = discovered.found.find((item) => item.sessionId === options.sessionId);
  if (!candidate) return { status: discovered.complete ? "not_found" : "unavailable" };
  try {
    const read = await readDetails(candidate, options, host, {
      bytes: options.limits.maxContentBytes,
    });
    if (!read || read.parsed.cwd !== options.cwd) return { status: "unavailable" };
    return {
      status: "ok",
      excerpt: {
        model: read.parsed.model,
        updatedAtMs: read.parsed.updatedAtMs,
        initialRequest: read.parsed.initialRequest,
        recentTurns: read.parsed.recentTurns,
      },
    };
  } catch {
    return { status: "unavailable" };
  }
}
