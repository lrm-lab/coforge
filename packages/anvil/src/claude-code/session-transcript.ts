import type { ClaudeHistoryHost } from "./host";
import { isAbsolute, join } from "node:path";
import { type SessionResumeFacts } from "#src/contract";
import { asRecord } from "#src/json-record";
import { claudeUsageContextTokens } from "./observations";

/**
 * Claude Code's own session transcript, read for the idle-recycle decision and briefing.
 *
 * `CLAUDE_CONFIG_DIR` holding the session history is documented
 * (https://code.claude.com/docs/en/settings); the transcript layout below is NOT.
 * UNDOCUMENTED, observed with Claude Code 2.1.309 on 2026-10-23 (re-check when raising the Claude
 * Code version gate): `<configDir>/projects/<encoded cwd>/<sessionId>.jsonl` is one JSON object per
 * line; every record has an ISO `timestamp`; an `assistant` record carries `message.usage`
 * (`input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`) and one content block
 * (`thinking`, `text`, `tool_use`), so a reply spans several records with the same usage; sidechain
 * records say `isSidechain: true`; `<sessionId>/` beside the file holds `subagents/` and
 * `tool-results/`, which change while a session works without touching the transcript.
 */

/** The tail of the transcript read for facts: enough for the last few model requests. */
const FACTS_TAIL_BYTES = 512 * 1024;
/** Project directories probed for one session; the search stops here rather than walk a huge store. */
const MAX_PROJECT_DIRECTORIES = 5_000;
/** The sidecar directory is walked this many levels below the session directory. */
const SIDECAR_MAX_DEPTH = 2;

type Environment = Readonly<Record<string, string>> | undefined;

/**
 * The Claude config directory the Agent's `claude` uses: `CLAUDE_CONFIG_DIR` from the Agent's
 * `envVars` (which win) or the Daemon's environment, else `~/.claude`. A relative value is
 * undecidable here (it depends on the child's working directory), so it resolves to `undefined`.
 */
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

/**
 * `<configDir>/projects/<project>/<sessionId>.jsonl`, or `undefined` when the session has no
 * regular transcript there. Probes each project directory for the exact name instead of listing
 * its (possibly thousands of) sessions; a symlink is never followed.
 */
export async function findClaudeSessionTranscript(
  sessionId: string,
  envVars: Environment,
  host: ClaudeHistoryHost,
): Promise<string | undefined> {
  const configDir = claudeConfigDirectory(envVars, host);
  if (!configDir || !sessionId || /[\\/]/.test(sessionId) || sessionId.includes("..")) return;
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
      if ((await host.lstat(candidate)).isFile()) return candidate;
    } catch {
      // Not in this project directory.
    }
  }
}

/** The lines in the last `tailBytes` of `path`, minus a first line the window cut; `undefined` if unreadable. */
export async function readTranscriptTailLines(
  path: string,
  tailBytes: number,
  host: ClaudeHistoryHost,
): Promise<string[] | undefined> {
  try {
    const { text, startOffset } = await host.readFileTail(path, tailBytes);
    const lines = text.split("\n");
    if (startOffset > 0) lines.shift();
    return lines;
  } catch {
    return;
  }
}

/** Every parsed JSON object line of a transcript tail; malformed and non-object lines are skipped. */
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

/** Input + cache read + cache creation tokens of a `usage` object: the context one request carried. */
function contextTokens(usage: unknown): number | undefined {
  const record = asRecord(usage);
  if (!record) return;
  const total = claudeUsageContextTokens(record);
  return total > 0 ? total : undefined;
}

/** The latest modification time of `path` and what lies under it (down to `depth` levels). */
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

/**
 * What the transcript says about the session: its last activity (the newest record `timestamp`, or
 * a newer change under the session's sidecar directory) and the context its last request carried.
 * `undefined` when the transcript is absent or unreadable.
 */
export async function readClaudeSessionResumeFacts(
  options: {
    sessionId: string;
    envVars?: Environment;
  },
  host: ClaudeHistoryHost,
): Promise<SessionResumeFacts | undefined> {
  const path = await findClaudeSessionTranscript(options.sessionId, options.envVars, host);
  if (!path) return;
  const lines = await readTranscriptTailLines(path, FACTS_TAIL_BYTES, host);
  if (!lines) return;
  let lastActivityAtMs: number | undefined;
  let lastContextTokens: number | undefined;
  for (const record of transcriptRecords(lines)) {
    if (typeof record.timestamp === "string") {
      const parsed = Date.parse(record.timestamp);
      if (Number.isFinite(parsed)) lastActivityAtMs = Math.max(lastActivityAtMs ?? 0, parsed);
    }
    // A sidechain (subagent) request is activity, but its context is not the session's.
    if (record.type === "assistant" && record.isSidechain !== true)
      lastContextTokens = contextTokens(asRecord(record.message)?.usage) ?? lastContextTokens;
  }
  const sidecar = await latestMtimeUnder(path.replace(/\.jsonl$/, ""), host);
  if (sidecar !== undefined) lastActivityAtMs = Math.max(lastActivityAtMs ?? 0, sidecar);
  return {
    ...(lastActivityAtMs !== undefined ? { lastActivityAtMs } : {}),
    ...(lastContextTokens !== undefined ? { lastContextTokens } : {}),
  };
}
