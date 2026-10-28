import {
  buildConstructedPanel as buildNativePanel,
  readClaudeRecycleBriefing as readNativeBriefing,
  readClaudeSessionResumeFacts as readNativeFacts,
  findClaudeSessionTranscript as findNativeTranscript,
  readTranscriptActions as readNativeActions,
  collectRecentMessages as collectNativeMessages,
  readClaudeCodeUsage as readNativeUsage,
} from "@lrm/coforge-anvil/claude-code";
import { readTailLines } from "@lrm/coforge-anvil";
import { claudeRuntimeHost } from "#src/code-agent/claude-code/host";
export * from "@lrm/coforge-anvil/claude-code";

export const buildConstructedPanel = (options: Parameters<typeof buildNativePanel>[0]) =>
  buildNativePanel(options, claudeRuntimeHost);
export const readClaudeRecycleBriefing = (options: Parameters<typeof readNativeBriefing>[0]) =>
  readNativeBriefing(options, claudeRuntimeHost);
export const readClaudeSessionResumeFacts = (options: Parameters<typeof readNativeFacts>[0]) =>
  readNativeFacts(options, claudeRuntimeHost);
export const findClaudeSessionTranscript = (
  sessionId: string,
  envVars: Parameters<typeof findNativeTranscript>[1],
) => findNativeTranscript(sessionId, envVars, claudeRuntimeHost);
export const readTranscriptTailLines = (path: string, tailBytes: number) =>
  readTailLines(path, tailBytes, claudeRuntimeHost);
export const readTranscriptActions = (path: string) => readNativeActions(path, claudeRuntimeHost);
export const collectRecentMessages = (path: string, max: number) =>
  collectNativeMessages(path, max, claudeRuntimeHost);
export function readClaudeCodeUsage(
  workingDirectory: string,
  options: Omit<Parameters<typeof readNativeUsage>[1], "host"> = {},
) {
  return readNativeUsage(workingDirectory, { ...options, host: claudeRuntimeHost });
}
