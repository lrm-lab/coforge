import {
  readClaudeLocalSessionExcerpt,
  searchClaudeLocalSessions,
} from "@lrm/coforge-anvil/claude-code";
import { readCodexLocalSessionExcerpt, searchCodexLocalSessions } from "@lrm/coforge-anvil/codex";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import type {
  HandoffRuntimeProvider,
  LocalSessionEntry,
  LocalSessionExcerptResult,
} from "@lrm/coforge-sdk/internal";
import { claudeHistoryHost } from "#src/code-agent/claude-code/history-host";
import { codexHistoryHost } from "#src/code-agent/codex/history-host";
import type {
  LocalSessionExcerptOptions,
  LocalSessionSearchOptions,
  NativeLocalSessionExcerpt,
  NativeLocalSessionExcerptRead,
  NativeLocalSessionSearch,
} from "@lrm/coforge-anvil";

export const LOCAL_SESSION_SEARCH_TIMEOUT_MS = 2_000;
export const LOCAL_SESSION_MAX_DIRECTORIES = 5_000;
export const LOCAL_SESSION_MAX_FILES = 20_000;
export const LOCAL_SESSION_MAX_CONTENT_BYTES = 64 * 1024 * 1024;
export const LOCAL_SESSION_MAX_FILE_BYTES = 1024 * 1024;
const MAX_RESULTS = 100;
const EXCERPT_BYTES = 24 * 1024;

type Source = {
  search(options: LocalSessionSearchOptions): Promise<NativeLocalSessionSearch>;
  excerpt(options: LocalSessionExcerptOptions): Promise<NativeLocalSessionExcerptRead>;
};

type Sources = { claude: Source; codex: Source; now: () => number; timeoutMs?: number };

function defaultSources(): Sources {
  return {
    claude: {
      search: (options) => searchClaudeLocalSessions(options, claudeHistoryHost),
      excerpt: (options) => readClaudeLocalSessionExcerpt(options, claudeHistoryHost),
    },
    codex: {
      search: (options) => searchCodexLocalSessions(options, codexHistoryHost),
      excerpt: (options) => readCodexLocalSessionExcerpt(options, codexHistoryHost),
    },
    now: Date.now,
  };
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maxBytes) return value;
  let out = "";
  let bytes = 0;
  for (const character of value) {
    const width = encoder.encode(character).byteLength;
    if (bytes + width > maxBytes) break;
    out += character;
    bytes += width;
  }
  return out;
}

function fitExcerpt(
  excerpt: NativeLocalSessionExcerpt,
): Omit<
  LocalSessionExcerptResult,
  "protocolMajor" | "requestId" | "workspaceId" | "computerId" | "provider" | "sessionId" | "cwd"
> {
  const initialRequest = truncateUtf8(excerpt.initialRequest, Math.floor(EXCERPT_BYTES / 3));
  let remaining = EXCERPT_BYTES - new TextEncoder().encode(initialRequest).byteLength;
  const kept = [] as NativeLocalSessionExcerpt["recentTurns"];
  for (const turn of excerpt.recentTurns.slice(-12).reverse()) {
    const text = truncateUtf8(turn.text, Math.min(8_192, remaining));
    if (!text) break;
    kept.push({ ...turn, text });
    remaining -= new TextEncoder().encode(text).byteLength;
  }
  return {
    status: "ok",
    model: excerpt.model.slice(0, 200),
    updatedAtMs: Math.max(0, Math.floor(excerpt.updatedAtMs)),
    initialRequest,
    recentTurns: kept.reverse(),
  };
}

export class LocalSessionCatalog {
  readonly #outstandingIo = new Set<Promise<unknown>>();

  constructor(private readonly sources: Sources = defaultSources()) {}

  private limits(divisor = 1) {
    const now = this.sources.now;
    return {
      maxResults: MAX_RESULTS,
      maxDirectories: Math.floor(LOCAL_SESSION_MAX_DIRECTORIES / divisor),
      maxFiles: Math.floor(LOCAL_SESSION_MAX_FILES / divisor),
      maxContentBytes: Math.floor(LOCAL_SESSION_MAX_CONTENT_BYTES / divisor),
      maxFileBytes: LOCAL_SESSION_MAX_FILE_BYTES,
      deadlineAtMs: now() + (this.sources.timeoutMs ?? LOCAL_SESSION_SEARCH_TIMEOUT_MS),
      now,
      outstandingIo: this.#outstandingIo,
    };
  }

  async search(query: string) {
    if (this.#outstandingIo.size > 0)
      return { sessions: [], scanComplete: false, contentSearchComplete: false };
    const failed = {
      sessions: [],
      scanComplete: false,
      contentSearchComplete: false,
    };
    const [claude, codex] = await Promise.all([
      this.sources.claude.search({ query, limits: this.limits(2) }).catch(() => failed),
      this.sources.codex.search({ query, limits: this.limits(2) }).catch(() => failed),
    ]);
    const merged: LocalSessionEntry[] = [
      ...claude.sessions.map((session) => ({
        ...session,
        provider: RUNTIME_PROVIDER.CLAUDE_CODE,
      })),
      ...codex.sessions.map((session) => ({
        ...session,
        provider: RUNTIME_PROVIDER.CODEX,
      })),
    ].sort((a, b) => b.updatedAtMs - a.updatedAtMs);
    const truncated = merged.length > MAX_RESULTS;
    return {
      sessions: merged.slice(0, MAX_RESULTS),
      scanComplete: claude.scanComplete && codex.scanComplete && !truncated,
      contentSearchComplete:
        claude.contentSearchComplete && codex.contentSearchComplete && (!query || !truncated),
    };
  }

  async excerpt(provider: HandoffRuntimeProvider, sessionId: string, cwd: string) {
    if (this.#outstandingIo.size > 0)
      return {
        status: "unavailable" as const,
        model: "",
        updatedAtMs: 0,
        initialRequest: "",
        recentTurns: [],
      };
    const source =
      provider === RUNTIME_PROVIDER.CLAUDE_CODE ? this.sources.claude : this.sources.codex;
    try {
      const result = await source.excerpt({ sessionId, cwd, limits: this.limits() });
      return result.status === "ok"
        ? fitExcerpt(result.excerpt)
        : {
            status: result.status,
            model: "",
            updatedAtMs: 0,
            initialRequest: "",
            recentTurns: [],
          };
    } catch {
      return {
        status: "unavailable" as const,
        model: "",
        updatedAtMs: 0,
        initialRequest: "",
        recentTurns: [],
      };
    }
  }
}
