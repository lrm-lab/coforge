import type { ClaudeFileInfo, ClaudeHistoryHost } from "./host";
import { isAbsolute, join } from "node:path";
import { type PromptCacheTier, type SessionResumeFacts } from "#src/contract";
import { asRecord } from "#src/json-record";
import { claudeUsageContextTokens } from "./observations";
import { readTailLines } from "#src/transcript-tail";

const FACTS_TAIL_BYTES = 512 * 1024;
const MAX_PROJECT_DIRECTORIES = 5_000;
const SIDECAR_MAX_DEPTH = 2;
const MAX_CACHED_TRANSCRIPTS = 512;

type Environment = Readonly<Record<string, string>> | undefined;

type ParsedTranscriptFacts = Readonly<{
  transcriptLastActivityAtMs: number | undefined;
  lastContextTokens: number | undefined;
  cacheTier: PromptCacheTier | undefined;
}>;

type CachedClaudeTranscript = ParsedTranscriptFacts &
  Readonly<{
    path: string;
    mtimeMs: number;
    size: number;
  }>;

const transcriptFactsCache = new WeakMap<ClaudeHistoryHost, Map<string, CachedClaudeTranscript>>();

function hostCache(host: ClaudeHistoryHost): Map<string, CachedClaudeTranscript> {
  let cache = transcriptFactsCache.get(host);
  if (!cache) {
    cache = new Map();
    transcriptFactsCache.set(host, cache);
  }
  return cache;
}

function rememberTranscript(
  cache: Map<string, CachedClaudeTranscript>,
  key: string,
  entry: CachedClaudeTranscript,
): void {
  cache.delete(key);
  cache.set(key, entry);
  if (cache.size > MAX_CACHED_TRANSCRIPTS) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

function claudeConfigDirectory(envVars: Environment, host: ClaudeHistoryHost): string | undefined {
  const configured = (
    envVars?.CLAUDE_CONFIG_DIR ?? host.readHostEnvironment("CLAUDE_CONFIG_DIR")
  )?.trim();
  if (configured) return isAbsolute(configured) ? configured : undefined;
  return join(
    (envVars?.HOME ?? host.readHostEnvironment("HOME"))?.trim() || host.homeDirectory(),
    ".claude",
  );
}

async function findClaudeSessionTranscriptWithStat(
  configDir: string,
  sessionId: string,
  host: ClaudeHistoryHost,
): Promise<{ path: string; info: ClaudeFileInfo } | undefined> {
  const projects = join(configDir, "projects");
  let entries;
  try {
    entries = await host.readDirectoryEntries(projects);
  } catch {
    return;
  }
  const filename = `${sessionId}.jsonl`;
  let probed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (++probed > MAX_PROJECT_DIRECTORIES) return;
    const candidate = join(projects, entry.name, filename);
    try {
      const info = await host.lstat(candidate);
      if (info.isFile()) return { path: candidate, info };
    } catch {
      continue;
    }
  }
}

export async function findClaudeSessionTranscript(
  sessionId: string,
  envVars: Environment,
  host: ClaudeHistoryHost,
): Promise<string | undefined> {
  const configDir = claudeConfigDirectory(envVars, host);
  if (!configDir || !sessionId || /[\\/]/.test(sessionId) || sessionId.includes("..")) return;
  return (await findClaudeSessionTranscriptWithStat(configDir, sessionId, host))?.path;
}

export function* transcriptRecords(lines: readonly string[]): Generator<Record<string, unknown>> {
  for (const line of lines) {
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const record = asRecord(parsed);
    if (record && !Array.isArray(parsed)) yield record;
  }
}

function contextTokens(usage: unknown): number | undefined {
  const record = asRecord(usage);
  if (!record) return;
  const total = claudeUsageContextTokens(record);
  return total > 0 ? total : undefined;
}

function positiveFinite(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function usageCacheTier(usage: unknown): PromptCacheTier | undefined {
  const creation = asRecord(asRecord(usage)?.cache_creation);
  if (!creation) return undefined;
  if (positiveFinite(creation.ephemeral_1h_input_tokens)) return "1h";
  if (positiveFinite(creation.ephemeral_5m_input_tokens)) return "5m";
  return undefined;
}

async function latestMtimeUnder(
  path: string,
  host: ClaudeHistoryHost,
  depth = 0,
): Promise<number | undefined> {
  let info;
  try {
    info = await host.lstat(path);
  } catch {
    return;
  }
  let latest = info.mtimeMs;
  if (!info.isDirectory() || depth >= SIDECAR_MAX_DEPTH) return latest;
  let names: readonly string[];
  try {
    names = await host.readDirectoryNames(path);
  } catch {
    return latest;
  }
  for (const name of names)
    latest = Math.max(latest, (await latestMtimeUnder(join(path, name), host, depth + 1)) ?? 0);
  return latest;
}

function parseTranscriptFacts(lines: readonly string[]): ParsedTranscriptFacts {
  let transcriptLastActivityAtMs: number | undefined;
  let lastContextTokens: number | undefined;
  let cacheTier: PromptCacheTier | undefined;
  for (const record of transcriptRecords(lines)) {
    if (typeof record.timestamp === "string") {
      const parsed = Date.parse(record.timestamp);
      if (Number.isFinite(parsed))
        transcriptLastActivityAtMs = Math.max(transcriptLastActivityAtMs ?? 0, parsed);
    }
    if (record.type === "assistant" && record.isSidechain !== true) {
      const usage = asRecord(record.message)?.usage;
      lastContextTokens = contextTokens(usage) ?? lastContextTokens;
      cacheTier = usageCacheTier(usage) ?? cacheTier;
    }
  }
  return { transcriptLastActivityAtMs, lastContextTokens, cacheTier };
}

function finalizeResumeFacts(
  parsed: ParsedTranscriptFacts,
  sidecarMtimeMs: number | undefined,
): SessionResumeFacts {
  const lastActivityAtMs =
    sidecarMtimeMs === undefined
      ? parsed.transcriptLastActivityAtMs
      : Math.max(parsed.transcriptLastActivityAtMs ?? 0, sidecarMtimeMs);
  return {
    ...(lastActivityAtMs !== undefined ? { lastActivityAtMs } : {}),
    ...(parsed.lastContextTokens !== undefined
      ? { lastContextTokens: parsed.lastContextTokens }
      : {}),
    ...(parsed.cacheTier !== undefined ? { cacheTier: parsed.cacheTier } : {}),
  };
}

export async function readClaudeSessionResumeFacts(
  options: {
    sessionId: string;
    envVars?: Environment;
  },
  host: ClaudeHistoryHost,
): Promise<SessionResumeFacts | undefined> {
  const configDir = claudeConfigDirectory(options.envVars, host);
  if (
    !configDir ||
    !options.sessionId ||
    /[\\/]/.test(options.sessionId) ||
    options.sessionId.includes("..")
  )
    return;
  const cache = hostCache(host);
  const cacheKey = `${configDir}\0${options.sessionId}`;
  const cached = cache.get(cacheKey);
  let target: { path: string; info: ClaudeFileInfo } | undefined;
  if (cached) {
    let info: ClaudeFileInfo | undefined;
    try {
      info = await host.lstat(cached.path);
    } catch {
      info = undefined;
    }
    if (info?.isFile()) {
      if (info.mtimeMs === cached.mtimeMs && info.size === cached.size) {
        rememberTranscript(cache, cacheKey, cached);
        const sidecar = await latestMtimeUnder(cached.path.replace(/\.jsonl$/, ""), host);
        return finalizeResumeFacts(cached, sidecar);
      }
      target = { path: cached.path, info };
    } else {
      cache.delete(cacheKey);
    }
  }
  target ??= await findClaudeSessionTranscriptWithStat(configDir, options.sessionId, host);
  if (!target) return;
  const lines = await readTailLines(target.path, FACTS_TAIL_BYTES, host);
  if (!lines) return;
  const parsed = parseTranscriptFacts(lines);
  rememberTranscript(cache, cacheKey, {
    path: target.path,
    mtimeMs: target.info.mtimeMs,
    size: target.info.size,
    ...parsed,
  });
  const sidecar = await latestMtimeUnder(target.path.replace(/\.jsonl$/, ""), host);
  return finalizeResumeFacts(parsed, sidecar);
}
