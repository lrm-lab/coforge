import { Command } from "commander";
import type { DoctorCommand } from "#src/doctor/doctor-command";
import type { StatusCommand } from "#src/status/status-command";

export type DiagnosticCommandDependencies = {
  status?: StatusCommand;
  doctor?: DoctorCommand;
};

export function registerDiagnosticCommands(
  program: Command,
  dependencies: DiagnosticCommandDependencies,
  setJson: (value: boolean) => void,
  setExitCode: (value: number) => void,
): void {
  program
    .command("status")
    .description(
      "Show the Install, Supervisor, Workspaces, Agents, and locks in one place. Read-only.",
    )
    .option("--json", "write one stable JSON result to stdout")
    .action((options: { json?: boolean }) => {
      setJson(options.json ?? false);
      return requireStatus(dependencies).run({ json: options.json ?? false });
    });
  program
    .command("doctor")
    .description("Check the local Computer installation and configured Workspaces. Read-only.")
    .option("--json", "write one stable JSON result to stdout")
    .action(async (options: { json?: boolean }) => {
      const json = options.json ?? false;
      setJson(json);
      setExitCode(await requireDoctor(dependencies).run({ json }));
    });
}

function requireStatus(dependencies: DiagnosticCommandDependencies): StatusCommand {
  if (!dependencies.status) throw new Error("Status is unavailable in this build");
  return dependencies.status;
}

function requireDoctor(dependencies: DiagnosticCommandDependencies): DoctorCommand {
  if (!dependencies.doctor) throw new Error("Doctor is unavailable in this build");
  return dependencies.doctor;
}
