import type { UsageSnapshot, AgentSession, AgentSessionOptions } from "@coforge/agent";
import type { CodeAgentProvider } from "@lrm/coforge-anvil";
import { JsonlProcess } from "@lrm/coforge-anvil/execution";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { processSpawner } from "#src/code-agent/process-host";
import { readClaudeCodeUsage } from "./usage";
import { claudeLaunchCommand, claudeLaunchEnvironment } from "./launch-args";
import { createPromptFile } from "./prompt-file";
import { readClaudeRecycleBriefing } from "./recycle-briefing";
import { readClaudeSessionResumeFacts } from "./session-transcript";
import { ClaudeCodeAgentSession } from "./provider";

export class ClaudeCodeProvider implements CodeAgentProvider {
  readonly provider = RUNTIME_PROVIDER.CLAUDE_CODE;
  readonly #command: readonly string[];

  constructor(options: { command?: readonly string[] } = {}) {
    this.#command = options.command ?? [
      "claude",
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
    ];
  }

  async readUsage(options: {
    workingDirectory: string;
    timeoutMs?: number;
  }): Promise<UsageSnapshot | null> {
    return readClaudeCodeUsage(options.workingDirectory, {
      command: this.#command.slice(0, 1),
      timeoutMs: options.timeoutMs,
    });
  }

  readonly readSessionResumeFacts = readClaudeSessionResumeFacts;
  readonly readRecycleBriefing = readClaudeRecycleBriefing;

  async createAgentSession(options: AgentSessionOptions): Promise<AgentSession> {
    if (options.sessionId !== undefined && !options.sessionId.trim())
      throw new Error("Invalid session ID");
    const prompt = await createPromptFile(options.instructions);
    let process: JsonlProcess | undefined;
    try {
      const command = (resumeSessionId?: string, createSessionId?: string) =>
        claudeLaunchCommand(this.#command, {
          promptPath: prompt.path,
          runtime: options.runtime,
          resumeSessionId,
          createSessionId,
        });
      const initialFreshSessionId = options.sessionId ? undefined : crypto.randomUUID();
      const { environment, autoCompactWindow } = claudeLaunchEnvironment(options);
      const spawn = (sessionId?: string, freshSessionId?: string) =>
        new JsonlProcess(
          command(sessionId, freshSessionId),
          options.agentWorkspaceDirectory,
          environment,
          processSpawner,
        );
      process = spawn(options.sessionId, initialFreshSessionId);
      const session = new ClaudeCodeAgentSession(
        process,
        () => prompt.remove(),
        options.onSessionId,
        options.sessionId,
        () => {
          const sessionId = crypto.randomUUID();
          return { process: spawn(undefined, sessionId), sessionId };
        },
        initialFreshSessionId,
        options.runtime?.model,
        autoCompactWindow,
      );
      await session.ready();
      return session;
    } catch (error) {
      try {
        await process?.dispose();
      } finally {
        await prompt.remove();
      }
      throw error;
    }
  }
}
