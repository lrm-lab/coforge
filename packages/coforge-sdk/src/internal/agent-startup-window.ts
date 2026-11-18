import { RUNTIME_PROVIDER } from "./runtime-provider";

export const AGENT_STARTUP_TIMEOUT_MS = 120_000;
export const SLOW_STARTUP_TIMEOUT_MS = 600_000;
export const STARTUP_DEADLINE_SLACK_MS = 60_000;

export const SLOW_STARTUP_PROVIDERS: ReadonlySet<string> = new Set([
  RUNTIME_PROVIDER.OPENCODE,
  RUNTIME_PROVIDER.GROK,
  RUNTIME_PROVIDER.ANTIGRAVITY,
]);

export function startupTimeoutMs(provider: string): number {
  return SLOW_STARTUP_PROVIDERS.has(provider) ? SLOW_STARTUP_TIMEOUT_MS : AGENT_STARTUP_TIMEOUT_MS;
}

export function startupDeadlineMs(provider: string): number {
  return startupTimeoutMs(provider) * 2 + STARTUP_DEADLINE_SLACK_MS;
}
