import type { ManagedRunnerIdentity } from "@lrm/coforge-sdk/internal";
import type { DaemonCommandRunner } from "@lrm/coforge-daemon";
import { CliError } from "#src/errors";
import { terminalText } from "#src/terminal-output";

export type RunnerCommand = {
  list(workspace: string | undefined, options: { json: boolean }): Promise<void>;
  stop(agentId: string, workspace: string | undefined, options: { json: boolean }): Promise<void>;
};

export function createRunnerCommand(input: {
  daemon: Pick<DaemonCommandRunner, "ensureRunning" | "runners">;
  resolveWorkspace?: (selector: string) => Promise<{ id: string; slug: string }>;
  write?: (line: string) => void;
}): RunnerCommand {
  const write = input.write ?? (() => {});
  const resolve = async (selector: string | undefined) => {
    if (!selector) return undefined;
    if (!input.resolveWorkspace) throw new Error("Workspace selection is unavailable");
    return input.resolveWorkspace(selector);
  };
  const runners = async (
    operation: "list" | "stop",
    workspaceId: string | undefined,
    agentId?: string,
  ): Promise<ManagedRunnerIdentity[]> => {
    if (!input.daemon.runners) throw new Error("Runner control is unavailable in this build");
    return input.daemon.runners(operation, workspaceId, agentId);
  };
  return {
    async list(workspace, options) {
      const local = await resolve(workspace);
      await input.daemon.ensureRunning();
      const values = await runners("list", local?.id ?? workspace);
      if (options.json) {
        write(JSON.stringify({ runners: values }));
        return;
      }
      write(`Runners (${values.length})`);
      for (const runner of values) write(renderRunner(runner));
    },
    async stop(agentId, workspace, options) {
      if (!workspace) {
        throw new CliError(
          "RUNNER_WORKSPACE_REQUIRED",
          "Runner stop requires --workspace <slug-or-id>.",
          "Run 'coforge-computer runners list' to inspect runners, then stop one in its Workspace.",
        );
      }
      const local = await resolve(workspace);
      await input.daemon.ensureRunning();
      const remaining = await runners("stop", local?.id ?? workspace, agentId);
      const workspaceId = local?.id ?? workspace;
      if (options.json) {
        write(JSON.stringify({ agentId, workspaceId, stopped: true, runners: remaining }));
        return;
      }
      write(`Stopped runner ${terminalText(agentId)} in Workspace ${terminalText(workspace)}.`);
    },
  };
}

function renderRunner(runner: ManagedRunnerIdentity): string {
  const turn = runner.hasLiveTurn === undefined ? "unknown" : runner.hasLiveTurn ? "busy" : "idle";
  return [
    `  ${terminalText(runner.agentId)}`,
    `workspace=${terminalText(runner.workspaceId)}`,
    `provider=${terminalText(runner.provider)}`,
    `model=${terminalText(runner.model)}`,
    `state=${runner.state}`,
    `turn=${turn}`,
    ...(runner.launchId ? [`launch=${terminalText(runner.launchId)}`] : []),
    ...(runner.sessionId ? [`session=${terminalText(runner.sessionId)}`] : []),
  ].join("  ");
}
