import { relative, isAbsolute, join } from "node:path";
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
  return undefined;
}
