import { Command } from "commander";
import type { RunnerCommand } from "#src/runners/runner-command";

export function registerRunnersCommand(
  program: Command,
  command: RunnerCommand | undefined,
  setJson: (value: boolean) => void,
): void {
  const runners = program.command("runners").description("Inspect and stop local Agent runners.");
  runners
    .command("list")
    .description("List locally supervised Agent runners.")
    .option("--workspace <slug-or-id>", "limit the list to one Workspace")
    .option("--json", "write one stable JSON result to stdout")
    .action((options: { workspace?: string; json?: boolean }) => {
      setJson(options.json ?? false);
      return requireRunners(command).list(options.workspace, { json: options.json ?? false });
    });
  runners
    .command("stop <agent-id>")
    .description("Stop one local Agent runner in a Workspace.")
    .option("--workspace <slug-or-id>", "Workspace that owns the runner")
    .option("--json", "write one stable JSON result to stdout")
    .action((agentId: string, options: { workspace?: string; json?: boolean }) => {
      setJson(options.json ?? false);
      return requireRunners(command).stop(agentId, options.workspace, {
        json: options.json ?? false,
      });
    });
}

function requireRunners(command: RunnerCommand | undefined): RunnerCommand {
  if (!command) throw new Error("Runner control is unavailable in this build");
  return command;
}
