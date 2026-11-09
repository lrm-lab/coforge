import { relative, isAbsolute, join } from "node:path";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { findClaudeSessionTranscript } from "@lrm/coforge-anvil/claude-code";
import { findCodexRollout } from "@lrm/coforge-anvil/codex";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { claudeHistoryHost } from "#src/code-agent/claude-code/history-host";
import { codexHistoryHost } from "#src/code-agent/codex/history-host";
import { CONTEXT_VIEW_PROVIDERS } from "./context-view-providers";

export type ProviderTranscriptSource = { absolute: string; relative: string };

export function providerTranscriptRoot(
  runtime: string,
  envVars?: Readonly<Record<string, string>>,
): string | undefined {
  const env: Readonly<Record<string, string | undefined>> = envVars ?? Bun.env;
  return CONTEXT_VIEW_PROVIDERS[runtime as keyof typeof CONTEXT_VIEW_PROVIDERS]?.sessionRoot(env);
}

export function resolveProviderTranscriptToken(
  runtime: string,
  token: string,
  envVars?: Readonly<Record<string, string>>,
): string | undefined {
  const separator = token.indexOf(":");
  if (separator < 1) return undefined;
  const prefix = token.slice(0, separator);
  const relativePath = token.slice(separator + 1);
  if (
    prefix !== runtime ||
    !relativePath ||
    relativePath.startsWith("/") ||
    relativePath.includes("\0")
  )
    return undefined;
  const root = providerTranscriptRoot(runtime, envVars);
  if (!root || !isAbsolute(root)) return undefined;
  const absolute = join(root, relativePath);
  return relative(root, absolute).startsWith("..") ? undefined : absolute;
}

function relativeSource(
  root: string,
  absolute: string,
  prefix: string,
): ProviderTranscriptSource | undefined {
  if (!isAbsolute(root) || !isAbsolute(absolute)) return undefined;
  const path = relative(root, absolute);
  if (!path || path.startsWith("..") || isAbsolute(path)) return undefined;
  return { absolute, relative: `${prefix}:${path}` };
}

function findKimiSessionDirectory(root: string, sessionId: string): string | null | undefined {
  const indexPath = join(root, "session_index.jsonl");
  let indexed: string | null | undefined;
  try {
    for (const line of readFileSync(indexPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        const indexedId = entry.sessionId ?? entry.session_id;
        if (indexedId !== sessionId) continue;
        if (entry.deleted === true) {
          indexed = null;
          continue;
        }
        const rawDir = entry.sessionDir ?? entry.session_dir;
        if (typeof rawDir !== "string") continue;
        const candidate = isAbsolute(rawDir) ? rawDir : join(root, rawDir);
        if (relative(root, candidate).startsWith("..")) return undefined;
        if (existsSync(candidate) && statSync(candidate).isDirectory()) indexed = candidate;
      } catch {
        // Ignore malformed index rows and continue with the next row.
      }
    }
  } catch {
    // The index is optional for older Kimi installations.
  }
  if (indexed !== undefined) return indexed;
  if (!sessionId || sessionId === "." || sessionId === ".." || /[/\0]/.test(sessionId))
    return undefined;
  const sessionsRoot = join(root, "sessions");
  try {
    for (const parent of readdirSync(sessionsRoot, { withFileTypes: true }).slice(0, 10_000)) {
      if (!parent.isDirectory()) continue;
      const candidate = join(sessionsRoot, parent.name, sessionId);
      if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** The provider's own transcript for a session, for the providers that keep one. A `captured`
 * provider (Pi, the built-in Agent) reports its request log path on the session instead. */
export async function findProviderTranscript(
  runtime: string,
  sessionId: string,
  envVars?: Readonly<Record<string, string>>,
): Promise<ProviderTranscriptSource | undefined> {
  if (runtime === RUNTIME_PROVIDER.CLAUDE_CODE) {
    const absolute = await findClaudeSessionTranscript(sessionId, envVars, claudeHistoryHost);
    const root = providerTranscriptRoot(runtime, envVars);
    return absolute && root
      ? relativeSource(root, absolute, RUNTIME_PROVIDER.CLAUDE_CODE)
      : undefined;
  }
  if (runtime === RUNTIME_PROVIDER.CODEX) {
    const absolute = await findCodexRollout(sessionId, envVars, codexHistoryHost);
    const root = providerTranscriptRoot(runtime, envVars);
    return absolute && root ? relativeSource(root, absolute, RUNTIME_PROVIDER.CODEX) : undefined;
  }
  if (runtime === "kimi-sdk") {
    const root = providerTranscriptRoot(runtime, envVars);
    const sessionDir = root ? findKimiSessionDirectory(root, sessionId) : undefined;
    const absolute = sessionDir
      ? [join(sessionDir, "agents", "main", "wire.jsonl"), join(sessionDir, "wire.jsonl")].find(
          (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
        )
      : undefined;
    return absolute && root ? relativeSource(root, absolute, "kimi-sdk") : undefined;
  }
  return undefined;
}
