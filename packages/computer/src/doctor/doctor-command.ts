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
    checkLocks(status),
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
    ...report.checks.flatMap((check) => {
      const lines = [`${check.ok ? "✓" : "✗"} ${check.name}: ${terminalText(check.detail)}`];
      const next = check.ok ? undefined : nextDoctorCommand(check.name, check.detail);
      if (next) lines.push(`  Next: ${next}`);
      return lines;
    }),
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
  // A Coordinator nobody registered with the platform manager is a way to run this Computer, not
  // a fault: the detached process a Linux machine without systemd starts, a container's
  // `foreground`, or someone's own supervisor (task #696, from the #417 acceptance). The detached
  // process reports itself loaded — it is, from its own pid file's point of view — so it is named
  // first, and saying what it will not survive is more use than "local RPC is reachable".
  if (status.supervisor.detached) {
    return {
      name: "supervisor",
      ok: true,
      detail:
        "running as the Computer's own detached process; no systemd on this machine, so it does not come back after a reboot",
    };
  }
  if (status.supervisor.loaded) {
    return { name: "supervisor", ok: true, detail: "local RPC is reachable" };
  }
  return {
    name: "supervisor",
    ok: true,
    detail: "running outside the platform service manager (an external supervisor or foreground)",
  };
}

function checkLocks(status: ComputerStatusReport): DoctorCheck {
  if (status.locks.machineMutationLock === "held") {
    return {
      name: "locks",
      ok: false,
      detail:
        "machine mutation lock is held; an install, upgrade, repair, or recovery may be running",
    };
  }
  if (status.locks.machineMutationLock === "unknown") {
    return {
      name: "locks",
      ok: false,
      detail: "machine mutation lock could not be inspected",
    };
  }
  // A lock nobody holds is the state worth reporting: the platform manager does not run a
  // Coordinator and none answers either, so the lock belongs to a process that is gone. A
  // Coordinator that does answer owns its lock whatever started it (task #696).
  const coordinatorRuns =
    status.supervisor.loaded || status.supervisor.rpc.reachable || status.supervisor.detached;
  if (!coordinatorRuns && status.locks.supervisorLock.present) {
    return {
      name: "locks",
      ok: false,
      detail: `supervisor lock is held by pid ${status.locks.supervisorLock.ownerPid ?? "unknown"}, but no CoForge Daemon is running`,
    };
  }
  return {
    name: "locks",
    ok: true,
    detail: `machine mutation lock free; supervisor lock ${
      status.locks.supervisorLock.present
        ? `held by pid ${status.locks.supervisorLock.ownerPid ?? "unknown"}`
        : "free"
    }`,
  };
}

function nextDoctorCommand(name: string, detail: string): string | undefined {
  if (name === "install") return "coforge-computer install";
  if (name === "supervisor") return "coforge-computer restart --supervisor";
  if (name === "locks") {
    if (detail.startsWith("machine mutation lock is held")) return "coforge-computer status";
    return "coforge-computer restart --supervisor";
  }
  if (name === "workspaces") {
    if (detail === "no workspace bindings configured") {
      return "coforge-computer setup --workspace <slug>";
    }
    return "coforge-computer status";
  }
  if (name === "leftover-upgrade-jobs") return "coforge-computer restart --supervisor";
  return undefined;
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
    return { name: "workspaces", ok: false, detail: "no workspace bindings configured" };
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
