import { claudeRuntimeHost } from "#src/code-agent/claude-code/host";
import {
  claudeFixtureProviderWithHost,
  controlledClaudeWithHost,
} from "../../../anvil/test/fixtures/claude-feed";
export * from "../../../anvil/test/fixtures/claude-feed";

export function claudeFixtureProvider(...args: string[]) {
  return claudeFixtureProviderWithHost(claudeRuntimeHost, ...args);
}
export function controlledClaude(
  sessionId?: string,
  onSessionId?: (id: string) => Promise<void>,
  ...args: string[]
) {
  return controlledClaudeWithHost(claudeRuntimeHost, sessionId, onSessionId, ...args);
}
