import { join } from "node:path";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { claudeHistoryHost } from "#src/code-agent/claude-code/history-host";
import { codexHistoryHost } from "#src/code-agent/codex/history-host";

/** How the daemon reads one provider's request log back, keyed by the `RuntimeProvider` value an
 * Agent's launch config carries. An Agent's own `provider` therefore selects its reader; a
 * provider absent here is reported `unsupported_runtime` (task #739: the set used to be named
 * "claude"/"builtin"/"kimi-sdk", which no Agent config ever holds). */
export type ContextViewProviderReading = {
  /** A record marker that proves a file is this provider's request log. */
  marker: Buffer;
  /** `native` reads the provider's own transcript; `captured` reads the request log the daemon
   * wrote alongside it (Pi and the built-in Agent write the same format). */
  source: "native" | "captured";
  /** Where the provider keeps its session transcripts, from the launch environment. Absent for a
   * `captured` provider, whose log path the session itself reports. */
  sessionRoot(envVars: Readonly<Record<string, string | undefined>>): string | undefined;
};

export const CONTEXT_VIEW_PROVIDERS = {
  [RUNTIME_PROVIDER.CLAUDE_CODE]: {
    marker: Buffer.from('"type":"api-request"', "utf8"),
    source: "native",
    sessionRoot: (envVars) =>
      envVars.CLAUDE_CONFIG_DIR?.trim() ||
      join(envVars.HOME || claudeHistoryHost.homeDirectory(), ".claude"),
  },
  [RUNTIME_PROVIDER.CODEX]: {
    marker: Buffer.from('"type":"additional_tools"', "utf8"),
    source: "native",
    sessionRoot: (envVars) =>
      envVars.CODEX_HOME?.trim() ||
      join(envVars.HOME || codexHistoryHost.homeDirectory(), ".codex"),
  },
  [RUNTIME_PROVIDER.PI]: {
    marker: Buffer.from('{"type":"request",', "utf8"),
    source: "captured",
    sessionRoot: () => undefined,
  },
  [RUNTIME_PROVIDER.COFORGE]: {
    marker: Buffer.from('{"type":"request",', "utf8"),
    source: "captured",
    sessionRoot: () => undefined,
  },
} as const satisfies Record<string, ContextViewProviderReading>;

export type ContextViewRuntime = keyof typeof CONTEXT_VIEW_PROVIDERS;
export const CONTEXT_VIEW_SUPPORTED_RUNTIMES = Object.keys(
  CONTEXT_VIEW_PROVIDERS,
) as ContextViewRuntime[];

/** The provider an Agent config names when the daemon can read its request log, else undefined. */
export function contextViewRuntime(value: string): ContextViewRuntime | undefined {
  return Object.hasOwn(CONTEXT_VIEW_PROVIDERS, value) ? (value as ContextViewRuntime) : undefined;
}
