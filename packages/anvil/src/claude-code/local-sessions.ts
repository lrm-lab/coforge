import { isAbsolute, join } from "node:path";
import { asRecord } from "#src/json-record";
import {
  localSessionField,
  localSessionSnippet,
  localSessionText,
  readLocalSessionWindows,
  type LocalSessionExcerptOptions,
  type LocalSessionSearchOptions,
  type NativeLocalSession,
  type NativeLocalSessionExcerpt,
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
    projects = await host.readDirectoryEntries(join(configDirectory(host), "projects"));
  } catch {
    return { found, complete: true };
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
      entries = await host.readDirectoryEntries(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (options.limits.now() >= options.limits.deadlineAtMs) {
        complete = false;
        break;
      }
      const match = SESSION_FILE.exec(entry.name);
      if (!match) continue;
      if (++files > options.limits.maxFiles) {
        complete = false;
        break;
      }
      const path = join(root, entry.name);
      try {
        const info = await host.lstat(path);
        if (!info.isFile()) continue;
        found.push({
          path,
          sessionId: match[1]!,
          modifiedAtMs: Number.isFinite(info.mtimeMs) ? Math.max(0, info.mtimeMs) : 0,
        });
      } catch {
        // A disappearing or unreadable transcript is not a session result.
      }
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
    const read = await readDetails(candidate, options, host, budget);
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

export async function readClaudeLocalSessionExcerpt(
  options: LocalSessionExcerptOptions,
  host: ClaudeHistoryHost,
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
