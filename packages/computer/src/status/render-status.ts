import { workspaceHealthRecoveryCommand, workspaceParkedMessage } from "@lrm/coforge-daemon";
import { truncateCodePoints } from "@lrm/coforge-sdk/internal";
import { terminalText } from "#src/terminal-output";
import type {
  ComputerStatusReport,
  PendingRequest,
  UnsettledUpgradeOperation,
  WorkspaceCloudStatus,
  WorkspaceHealth,
  WorkspaceStatus,
} from "./types";

/** One stable JSON object with the full report, matching `--json` conventions used by
 * `setup`/`login`: a single line on stdout, nothing else. */
export function renderStatusJson(report: ComputerStatusReport): string {
  return JSON.stringify(report);
}

/** Short aligned sections, one fact per line. Every user-controlled string (server URLs,
 * workspace IDs, paths) goes through `terminalText` before being written. */
export function renderStatusHuman(report: ComputerStatusReport): string[] {
  const lines: string[] = [];
  lines.push(`CoForge Computer status (${report.platform}) - ${report.generatedAt}`);
  lines.push("");
  lines.push(...renderInstall(report));
  lines.push("");
  lines.push(...renderSupervisor(report));
  lines.push("");
  lines.push(...renderWorkspaces(report));
  lines.push("");
  lines.push(...renderAgents(report));
  lines.push("");
  lines.push(...renderLocks(report));
  lines.push("");
  lines.push(...renderLeftoverJobs(report));
  const procLines = renderProcJobs(report);
  if (procLines.length > 0) {
    lines.push("");
    lines.push(...procLines);
  }
  return lines;
}

function renderInstall(report: ComputerStatusReport): string[] {
  const { install } = report;
  const lines = ["Install"];
  if (!install.readable) {
    lines.push(`  Error:                 ${terminalText(install.error)}`);
    return lines;
  }
  lines.push(
    `  Active version:        ${install.active ? terminalText(install.active.current) : "none"}`,
  );
  lines.push(
    `  Previous version:      ${install.active?.previous ? terminalText(install.active.previous) : "none"}`,
  );
  lines.push(
    `  Binary on PATH:        ${install.binaryOnPath ? terminalText(install.binaryOnPath) : "not found"}`,
  );
  lines.push(`  Resolves to active:    ${yesNo(install.resolvesToActive)}`);
  lines.push(`  Release feed:          ${terminalText(install.releaseFeedUrl)}`);
  if (install.unfinishedTransaction) {
    const tx = install.unfinishedTransaction;
    lines.push(
      tx.valid
        ? `  Unfinished upgrade:    ${tx.from ? `${terminalText(tx.from)} -> ` : "-> "}${terminalText(tx.to)} (request ${terminalText(tx.requestId)}) — run coforge-computer repair`
        : `  Unfinished upgrade:    unreadable (${terminalText(tx.error)}) — run coforge-computer repair`,
    );
  }
  return lines;
}

function renderSupervisor(report: ComputerStatusReport): string[] {
  const { supervisor } = report;
  const activeVersion =
    report.install.readable && report.install.active ? report.install.active.current : null;
  return [
    "Supervisor",
    `  Coordinator job:       ${terminalText(supervisor.label)}`,
    `  Loaded:                ${supervisor.loaded ? "yes" : "no"}`,
    ...(supervisor.detached
      ? [
          "  Run mode:              detached process (no systemd): it does not start at boot and is not restarted if it crashes",
        ]
      : []),
    ...renderExternalSupervisor(supervisor),
    ...renderServiceDefinition(supervisor),
    `  PID:                   ${supervisor.pid ?? "-"}`,
    `  Socket:                ${terminalText(supervisor.socketPath)}`,
    `  Local RPC:             ${
      supervisor.rpc.reachable
        ? `reachable (${supervisor.rpc.runtimeCount} workspace runtime(s))`
        : `unreachable (${terminalText(supervisor.rpc.error)})`
    }`,
    ...(supervisor.rpc.reachable && supervisor.rpc.versionSkew && supervisor.rpc.version
      ? [
          `  Version skew:          SERVICE_VERSION_SKEW (running ${terminalText(supervisor.rpc.version)}, active ${terminalText(activeVersion ?? "unknown")}) — run coforge-computer restart --supervisor`,
        ]
      : []),
    `  PATH source:           ${renderLoginShellPath(report.loginShellPath)}`,
  ];
}

function renderExternalSupervisor(supervisor: ComputerStatusReport["supervisor"]): string[] {
  const external = supervisor.externalSupervisor;
  if (!external) return [];
  const oom = external.oomPolicy
    ? `, OOMPolicy=${terminalText(external.oomPolicy)}${
        external.oomPolicy === "stop" || external.oomPolicy === "kill"
          ? " — set OOMPolicy=continue"
          : ""
      }`
    : "";
  return [
    `  External unit:         ${terminalText(external.unit)} (${external.scope} scope${oom})`,
  ];
}

/** Nothing where the platform keeps no service file to compare. `repair` is named only where the
 * service manager holds the service: for a foreground or container Computer, or one not set up,
 * there is no registration for it to fix. */
function renderServiceDefinition(supervisor: ComputerStatusReport["supervisor"]) {
  const label = "  Service definition:    ";
  const status = supervisor.serviceDefinition;
  if (!status) return [];
  if (status.state === "unreadable") return [`${label}unreadable (${terminalText(status.error)})`];
  if (status.state === "matches") return [`${label}matches`];
  return [`${label}${status.state}${supervisor.loaded ? " — run coforge-computer repair" : ""}`];
}

function renderLoginShellPath(status: ComputerStatusReport["loginShellPath"]): string {
  if (status.state === "imported")
    return `imported from ${terminalText(status.shell)} (${status.entryCount} entries)`;
  if (status.state === "not_probed") return "not yet probed";
  if (status.reason === "disabled" || status.reason === "skipped") return status.reason;
  return `failed: ${terminalText(status.reason)}`;
}

function renderWorkspaces(report: ComputerStatusReport): string[] {
  const { workspaces } = report;
  if (!workspaces.readable)
    return ["Workspaces", `  Error:                 ${terminalText(workspaces.error)}`];
  if (workspaces.workspaces.length === 0)
    return ["Workspaces", "  No workspace bindings configured."];
  const activeVersion =
    report.install.readable && report.install.active ? report.install.active.current : null;
  return [
    `Workspaces (${workspaces.workspaces.length})`,
    ...workspaces.workspaces.flatMap((workspace) => renderWorkspace(workspace, activeVersion)),
  ];
}

/** One Workspace binding: its summary line, then a detail line for each thing that needs
 * attention (cloud reason, pending or unsettled work, a failure to retry, degraded or parked). */
function renderWorkspace(workspace: WorkspaceStatus, activeVersion: string | null): string[] {
  const lines: string[] = [];
  const pid = workspace.pid === null ? "-" : `${workspace.pid} (${workspace.pidSource})`;
  lines.push(
    `  ${terminalText(workspace.workspaceId)}  server=${workspace.serverHttpUrl ? terminalText(workspace.serverHttpUrl) : "-"}  enabled=${workspace.enabled ? "yes" : "no"}  running=${workspace.running ? "yes" : "no"}  pid=${pid}  cloud=${workspace.cloudConnection?.state ?? "-"}`,
  );
  const cloudDetail = renderCloudConnection(workspace.cloudConnection);
  if (cloudDetail) lines.push(`    cloud: ${cloudDetail}`);
  if (workspace.versionSkew && workspace.version) {
    lines.push(
      `    version skew: SERVICE_VERSION_SKEW (running ${terminalText(workspace.version)}, active ${terminalText(activeVersion ?? "unknown")}) — run coforge-computer restart --workspace ${terminalText(workspace.workspaceSlug ?? workspace.workspaceId)}`,
    );
  }
  if (workspace.lockContention) {
    lines.push(
      `    lock contention: workspace-daemon-lock.sqlite is held by pid ${workspace.lockContention.holderPid ?? "unknown"}`,
    );
  }
  for (const pending of workspace.pending) lines.push(`    pending: ${renderPending(pending)}`);
  for (const unsettled of workspace.unsettledUpgrades)
    lines.push(`    unsettled upgrade: ${renderUnsettledUpgrade(unsettled)}`);
  if (workspace.underWay) lines.push("    under way: a start, restart, or setup is still running");
  if (workspace.lastFailure)
    lines.push(...renderLastFailure(workspace.workspaceId, workspace.lastFailure));
  if (workspace.health.status === "degraded") lines.push(...renderDegradedHealth(workspace));
  if (workspace.health.status === "parked") lines.push(...renderParkedHealth(workspace));
  return lines;
}

/** The last start, restart or setup that failed, and the command that retries it. */
function renderLastFailure(
  workspaceId: string,
  failure: NonNullable<WorkspaceStatus["lastFailure"]>,
): string[] {
  const { operation, message, at } = failure;
  // A setup's configuration was already taken, so what is left to retry is its start.
  const [label, retry] = operation === "configure" ? ["setup", "start"] : [operation, operation];
  return [
    `    last ${label} failed: ${terminalText(message)}  at=${terminalText(at)}`,
    `      retry: coforge-computer ${retry} --workspace ${terminalText(workspaceId)}`,
  ];
}

/** Why a Workspace's cloud connection is not up, when its handshake said so. The error is remote
 * text, so it is made terminal-safe. */
function renderCloudConnection(connection: WorkspaceCloudStatus | null): string | undefined {
  if (!connection?.error) return undefined;
  const error = shortened(terminalText(connection.error), CLOUD_REASON_MAX_LENGTH);
  if (connection.state === "connecting") return `retrying after ${error}`;
  if (connection.state === "not_connected") return `not connected (${error})`;
  return undefined;
}

/** A cloud connection reason is remote text of any length; status keeps its line readable. */
const CLOUD_REASON_MAX_LENGTH = 200;

function shortened(text: string, maxLength: number): string {
  if (truncateCodePoints(text, maxLength) === text) return text;
  return `${truncateCodePoints(text, maxLength - 1)}…`;
}

/** Only printed when a Workspace is actually degraded, so a healthy Workspace's output stays as
 * quiet as it is today. */
function renderDegradedHealth(workspace: {
  workspaceId: string;
  health: WorkspaceHealth;
}): string[] {
  const { health } = workspace;
  if (health.status !== "degraded") return [];
  return [
    `    degraded: ${terminalText(health.reason)}  crashes=${health.crashCount}  since=${terminalText(health.since)}`,
    `      recover: ${terminalText(workspaceHealthRecoveryCommand(workspace.workspaceId))}`,
  ];
}

/** A parked Workspace: the stable reason, then the sentence that says what happened and which
 * command moves on. */
function renderParkedHealth(workspace: {
  workspaceId: string;
  workspaceSlug: string | null;
  health: WorkspaceHealth;
}): string[] {
  const { health } = workspace;
  if (health.status !== "parked") return [];
  return [
    `    parked: ${health.reason}  since=${terminalText(health.since)}`,
    `      ${terminalText(
      workspaceParkedMessage(health.reason, {
        workspaceId: workspace.workspaceId,
        workspaceSlug: workspace.workspaceSlug ?? undefined,
      }),
    )}`,
  ];
}

function renderPending(pending: PendingRequest): string {
  return pending.kind === "restart"
    ? `restart ${terminalText(pending.requestId)} (${terminalText(pending.phase)})`
    : `upgrade ${terminalText(pending.requestId)} -> ${terminalText(pending.expectedVersion)}`;
}

function renderUnsettledUpgrade(operation: UnsettledUpgradeOperation): string {
  const error = operation.errorCode ? `  error=${terminalText(operation.errorCode)}` : "";
  return `${terminalText(operation.requestId)} -> ${terminalText(operation.expectedVersion)}  state=${operation.state}${error}  age=${Math.round(operation.ageMs / 1000)}s`;
}

function renderAgents(report: ComputerStatusReport): string[] {
  const { agents } = report;
  if (!agents.supported) return ["Agents", "  Not supported on this platform."];
  if (agents.workspaces.length === 0) return ["Agents", "  No workspace bindings configured."];
  const lines = ["Agents"];
  for (const workspace of agents.workspaces) {
    lines.push(
      `  ${terminalText(workspace.workspaceId)}: ${workspace.count} job(s)  (workspace job pid=${workspace.workspaceJobPid ?? "-"})`,
    );
    for (const job of workspace.jobs) {
      lines.push(`    ${terminalText(job.label)}  pid=${job.pid ?? "-"}`);
    }
  }
  return lines;
}

function renderLocks(report: ComputerStatusReport): string[] {
  const { locks } = report;
  const contendedWorkspaces = report.workspaces.readable
    ? report.workspaces.workspaces.filter((workspace) => workspace.lockContention)
    : [];
  return [
    "Locks",
    `  Machine mutation lock: ${locks.machineMutationLock}`,
    `  Supervisor lock:       ${
      locks.supervisorLock.present
        ? `held (owner pid ${locks.supervisorLock.ownerPid ?? "unknown"})`
        : "free"
    }`,
    ...contendedWorkspaces.map(
      (workspace) =>
        `  Workspace lock (${terminalText(workspace.workspaceSlug ?? workspace.workspaceId)}): held by contending pid ${workspace.lockContention!.holderPid ?? "unknown"}`,
    ),
  ];
}

function renderLeftoverJobs(report: ComputerStatusReport): string[] {
  const { leftoverJobs } = report;
  if (!leftoverJobs.supported)
    return ["Leftover upgrade jobs", "  Not supported on this platform."];
  if (leftoverJobs.jobs.length === 0) return ["Leftover upgrade jobs", "  none"];
  return [
    "Leftover upgrade jobs",
    ...leftoverJobs.jobs.map(
      (job) =>
        `  ${terminalText(job.label)}  pid=${job.pid ?? "-"}${job.runs !== null ? `  runs=${job.runs}` : ""}`,
    ),
  ];
}

function renderProcJobs(report: ComputerStatusReport): string[] {
  const { procJobs } = report;
  if (!procJobs) return [];
  if (!procJobs.supported) return ["Background jobs", "  Not supported on this platform."];
  if (procJobs.jobs.length === 0) return ["Background jobs", "  none"];
  return [
    `Background jobs (${procJobs.jobs.length} running)`,
    ...procJobs.jobs.map(
      (job) =>
        `  ${terminalText(job.workspaceId)}  agent=${terminalText(job.agentId)}  name=${terminalText(job.name)}  pid=${job.pid}`,
    ),
    "  Run coforge-computer stop --jobs to stop Agent background jobs.",
  ];
}

function yesNo(value: boolean | null): string {
  return value === null ? "unknown" : value ? "yes" : "no";
}
