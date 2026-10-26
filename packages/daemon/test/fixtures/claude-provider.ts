import { ClaudeCodeProvider } from "@lrm/coforge-anvil/claude-code";
import { claudeRuntimeHost } from "#src/code-agent/claude-code/host";
import { anvilRuntimeFixtures } from "./anvil-runtime";

export function claudeProvider(
  options: Omit<ConstructorParameters<typeof ClaudeCodeProvider>[0], "host"> = {},
) {
  return new ClaudeCodeProvider({ ...options, host: claudeRuntimeHost });
}
export const claudeUsageFixture = anvilRuntimeFixtures.claudeUsage;
