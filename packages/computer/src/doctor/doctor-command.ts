import { terminalText } from "#src/terminal-output";
import { collectComputerStatus } from "#src/status/collect-status";
import type { ComputerStatusReport, StatusPorts, WorkspaceStatus } from "#src/status/types";

export type DoctorCheck = { name: string; ok: boolean; detail: string };

export type DoctorReport = {
  schemaVersion: 1;
  generatedAt: string;
  ok: boolean;
  checks: DoctorCheck[];
};

export interface DoctorCommand {
  /** Returns the diagnostic exit code: zero when every check passes, one otherwise. */
  run(options: { json: boolean }): Promise<number>;
}

export function createDoctorCommand(
  io: { stdout: (line: string) => void },
  readStatus: (() => Promise<ComputerStatusReport>) | StatusPorts,
): DoctorCommand {
  const read =
    typeof readStatus === "function" ? readStatus : () => collectComputerStatus(readStatus);
  return {
    async run(options) {
      const report = createDoctorReport(await read());
      if (options.json) {
        io.stdout(renderDoctorJson(report));
      } else {
        for (const line of renderDoctorHuman(report)) io.stdout(line);
      }
      return report.ok ? 0 : 1;
    },
  };
}

export function createDoctorReport(status: ComputerStatusReport): DoctorReport {
  const checks = [
    checkInstall(status),
    checkSupervisor(status),
    checkLoginShellPath(status),
    checkWorkspaces(status),
    checkLeftoverJobs(status),
  ];
  return {
    schemaVersion: 1,
    generatedAt: status.generatedAt,
    ok: checks.every((check) => check.ok),
    checks,
  };
}

export function renderDoctorJson(report: DoctorReport): string {
  return JSON.stringify(report);
}

export function renderDoctorHuman(report: DoctorReport): string[] {
  return [
    "CoForge Computer doctor",
    ...report.checks.map(
      (check) => `${check.ok ? "✓" : "✗"} ${check.name}: ${terminalText(check.detail)}`,
    ),
    `Result: ${report.ok ? "healthy" : "action required"}`,
  ];
}

function checkInstall(status: ComputerStatusReport): DoctorCheck {
  if (!status.install.readable) {
    return { name: "install", ok: false, detail: status.install.error };
  }
  if (!status.install.active) {
    return { name: "install", ok: false, detail: "no active version is selected" };
  }
  if (!status.install.binaryOnPath) {
    return {
      name: "install",
      ok: false,
      detail: "the Computer executable was not found on PATH",
    };
  }
  if (status.install.resolvesToActive === false) {
    return {
      name: "install",
      ok: false,
      detail: "the executable on PATH does not resolve to the active version",
    };
  }
  return {
    name: "install",
    ok: true,
    detail: `active version ${status.install.active.current} is selected`,
  };
}

function checkSupervisor(status: ComputerStatusReport): DoctorCheck {
  if (!status.supervisor.rpc.reachable) {
    return {
      name: "supervisor",
      ok: false,
      detail: `local RPC is unreachable: ${status.supervisor.rpc.error}`,
    };
  }
  if (!status.supervisor.loaded) {
    return { name: "supervisor", ok: false, detail: "supervisor job is not loaded" };
  }
  return { name: "supervisor", ok: true, detail: "local RPC is reachable" };
}

function checkLoginShellPath(status: ComputerStatusReport): DoctorCheck {
  const path = status.loginShellPath;
  if (path.state === "imported") {
    return { name: "login-shell-path", ok: true, detail: `imported from ${path.shell}` };
  }
  if (path.state === "failed") {
    return { name: "login-shell-path", ok: false, detail: `import failed: ${path.reason}` };
  }
  return { name: "login-shell-path", ok: false, detail: "has not been probed" };
}

function checkWorkspaces(status: ComputerStatusReport): DoctorCheck {
  if (!status.workspaces.readable) {
    return { name: "workspaces", ok: false, detail: status.workspaces.error };
  }
  if (status.workspaces.workspaces.length === 0) {
    return { name: "workspaces", ok: true, detail: "no workspace bindings configured" };
  }
  const failures = status.workspaces.workspaces.flatMap(workspaceProblems);
  if (failures.length > 0) return { name: "workspaces", ok: false, detail: failures.join("; ") };
  const enabled = status.workspaces.workspaces.filter((workspace) => workspace.enabled).length;
  return {
    name: "workspaces",
    ok: true,
    detail: `${enabled} enabled workspace${enabled === 1 ? " is" : "s are"} running and connected`,
  };
}

function workspaceProblems(workspace: WorkspaceStatus): string[] {
  if (!workspace.enabled) return [];
  const problems: string[] = [];
  const label = workspace.workspaceSlug ?? workspace.workspaceId;
  if (!workspace.running) problems.push(`${label}: enabled but not running`);
  if (workspace.health.status !== "ok") {
    const reason = "reason" in workspace.health ? ` (${workspace.health.reason})` : "";
    const health = `health=${workspace.health.status}${reason}`;
    if (problems.length > 0) problems[problems.length - 1] += `; ${health}`;
    else problems.push(`${label}: ${health}`);
  }
  if (workspace.running && workspace.cloudConnection?.state !== "connected") {
    const state = workspace.cloudConnection?.state ?? "unknown";
    problems.push(`${label}: cloud=${state}`);
  }
  if (workspace.pending.length > 0) problems.push(`${label}: pending operation`);
  if (workspace.unsettledUpgrades.length > 0) problems.push(`${label}: unsettled upgrade`);
  if (workspace.lastFailure) problems.push(`${label}: last operation failed`);
  return problems;
}

function checkLeftoverJobs(status: ComputerStatusReport): DoctorCheck {
  if (!status.leftoverJobs.supported) {
    return { name: "leftover-upgrade-jobs", ok: true, detail: "not supported on this platform" };
  }
  const count = status.leftoverJobs.jobs.length;
  if (count === 0) return { name: "leftover-upgrade-jobs", ok: true, detail: "none" };
  return {
    name: "leftover-upgrade-jobs",
    ok: false,
    detail: `${count} leftover upgrade job${count === 1 ? "" : "s"}`,
  };
}
