import type { ClaudeRuntimeHost } from "./host";
import type { UsageSnapshot, AgentSession, AgentSessionOptions } from "@coforge/agent";
import { type CodeAgentProvider } from "#src/contract";
import { JsonlProcess } from "#src/jsonl-process";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { readClaudeCodeUsage } from "./usage";
import { claudeLaunchCommand } from "./launch-args";
import { readClaudeRecycleBriefing } from "./recycle-briefing";
import { readClaudeSessionResumeFacts } from "./session-transcript";
import { ClaudeCodeAgentSession } from "./session";

export class ClaudeCodeProvider implements CodeAgentProvider {
  readonly provider = RUNTIME_PROVIDER.CLAUDE_CODE;
  /** Claude's prompt cache is counted on for an hour, the recycle default before per-provider gaps. */
  readonly idleRecycleMinColdGapMs = 60 * 60_000;
  readonly #host: ClaudeRuntimeHost;
  readonly #command: readonly string[];

  constructor(options: { host: ClaudeRuntimeHost; command?: readonly string[] }) {
    this.#host = options.host;
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
      host: this.#host,
      command: this.#command.slice(0, 1),
      timeoutMs: options.timeoutMs,
    });
  }

  readonly readSessionResumeFacts = (options: Parameters<typeof readClaudeSessionResumeFacts>[0]) =>
    readClaudeSessionResumeFacts(options, this.#host);
  readonly readRecycleBriefing = (options: Parameters<typeof readClaudeRecycleBriefing>[0]) =>
    readClaudeRecycleBriefing(options, this.#host);

  async createAgentSession(options: AgentSessionOptions): Promise<AgentSession> {
    if (options.sessionId !== undefined && !options.sessionId.trim())
      throw new Error("Invalid session ID");
    const prompt = await this.#host.createPromptFile(options.instructions);
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
      const { environment, autoCompactWindow } = this.#host.buildSessionEnvironment(options);
      const spawn = (sessionId?: string, freshSessionId?: string) =>
        new JsonlProcess(
          command(sessionId, freshSessionId),
          options.agentWorkspaceDirectory,
          environment,
          this.#host.processTreeSpawner,
        );
      process = spawn(options.sessionId, initialFreshSessionId);
      const session = new ClaudeCodeAgentSession(
        this.#host,
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
