import type {
  AgentsStatus,
  ComputerStatusReport,
  DaemonSnapshotProbe,
  InstallStatus,
  PendingRequest,
  ServiceDefinitionStatus,
  StatusBinding,
  StatusPorts,
  SupervisorStatus,
  UnsettledUpgradeOperation,
  WorkspacesStatus,
} from "./types";
import { statusRecoveryComputerId } from "./types";
import { thrownMessage } from "@lrm/coforge-sdk/internal";

/** Assembles the read-only status report from injected ports. Every section is collected
 * independently and degrades on its own failure; only `install` can fail the whole report,
 * because every other section is reported relative to "which build is active". Agents is
 * collected before Workspaces because a Workspace's PID can fall back to the OS-job PID Agents
 * already reads. */
export async function collectComputerStatus(ports: StatusPorts): Promise<ComputerStatusReport> {
  const install = await collectInstall(ports);
  const activeVersion = install.readable && install.active ? install.active.current : null;
  const snapshot = await ports.probeDaemonSnapshot();
  const supervisor = await collectSupervisor(ports, snapshot, activeVersion);
  const bindingsLoad = await ports.loadBindings();
  const agents = await collectAgents(ports, bindingsLoad);
  const workspaces = await collectWorkspaces(
    ports,
    bindingsLoad,
    snapshot,
    agents,
    ports.now(),
    activeVersion,
  );
  const leftoverJobs = await collectLeftoverJobs(ports);
  const procJobs = await collectProcJobs(ports);
  const supervisorLockOwnerPid = await ports.readSupervisorLockOwner();
  return {
    schemaVersion: 1,
    generatedAt: ports.now().toISOString(),
    platform: ports.platform,
    install,
    supervisor,
    loginShellPath: ports.readLoginShellPath(),
    workspaces,
    agents,
    locks: {
      machineMutationLock: ports.probeMachineMutationLock(),
      supervisorLock: {
        present: supervisorLockOwnerPid !== null,
        ownerPid: supervisorLockOwnerPid,
      },
    },
    leftoverJobs,
    procJobs,
  };
}

async function collectInstall(ports: StatusPorts): Promise<InstallStatus> {
  const [read, unfinishedTransaction] = await Promise.all([
    ports.readActiveInstall(),
    ports.readInstallerJournal ? ports.readInstallerJournal().catch(() => null) : null,
  ]);
  if (read.kind === "corrupt") return { readable: false, error: read.error };
  const active =
    read.kind === "present" ? { current: read.current, previous: read.previous } : null;
  const binaryOnPath = await ports.locateBinaryOnPath();
  const resolvesToActive = await resolveBinaryMatchesActive(ports, binaryOnPath, active !== null);
  return {
    readable: true,
    active,
    binaryOnPath,
    resolvesToActive,
    releaseFeedUrl: ports.releaseFeedUrl,
    ...(unfinishedTransaction ? { unfinishedTransaction } : {}),
  };
}

async function resolveBinaryMatchesActive(
  ports: StatusPorts,
  binaryOnPath: string | null,
  hasActiveInstall: boolean,
): Promise<boolean | null> {
  if (!binaryOnPath || !hasActiveInstall) return null;
  const [onPathReal, activeReal] = await Promise.all([
    ports.resolveRealPath(binaryOnPath),
    ports.resolveRealPath(ports.activeBinaryPath),
  ]);
  if (!onPathReal || !activeReal) return null;
  return onPathReal === activeReal;
}

async function collectSupervisor(
  ports: StatusPorts,
  snapshot: DaemonSnapshotProbe,
  activeVersion: string | null,
): Promise<SupervisorStatus> {
  const [coordinator, serviceDefinition, externalSupervisor] = await Promise.all([
    ports.probeCoordinator(),
    collectServiceDefinition(ports),
    ports.readExternalSupervisor ? ports.readExternalSupervisor().catch(() => null) : null,
  ]);
  const memory =
    coordinator.pid !== null && ports.sampleProcessMemory
      ? await ports.sampleProcessMemory(coordinator.pid).catch(() => undefined)
      : undefined;
  const versionSkew =
    snapshot.reachable &&
    snapshot.version !== undefined &&
    activeVersion !== null &&
    snapshot.version !== activeVersion;
  return {
    label: ports.coordinatorLabel,
    loaded: coordinator.loaded,
    pid: coordinator.pid,
    ...(coordinator.detached ? { detached: true as const } : {}),
    socketPath: ports.socketPath,
    rpc: snapshot.reachable
      ? {
          reachable: true,
          runtimeCount: snapshot.runtimes.length,
          ...(snapshot.version ? { version: snapshot.version } : {}),
          ...(versionSkew ? { versionSkew: true as const } : {}),
        }
      : { reachable: false, error: snapshot.error },
    ...(serviceDefinition ? { serviceDefinition } : {}),
    ...(externalSupervisor ? { externalSupervisor } : {}),
    ...(memory ? { memory } : {}),
  };
}

/** Compares the service file on disk with the one this Computer would register: a launchd job
 * stays loaded after its plist is deleted, so `Loaded` alone cannot show the file went missing.
 * Undefined where the platform keeps no such file. */
async function collectServiceDefinition(
  ports: StatusPorts,
): Promise<ServiceDefinitionStatus | undefined> {
  try {
    const definition = await ports.readServiceDefinition();
    if (!definition) return undefined;
    const { path, expected, onDisk } = definition;
    if (onDisk === null) return { state: "missing", path };
    return { state: onDisk === expected ? "matches" : "differs", path };
  } catch (error) {
    return { state: "unreadable", error: thrownMessage(error) };
  }
}

async function collectWorkspaces(
  ports: StatusPorts,
  bindingsLoad: Awaited<ReturnType<StatusPorts["loadBindings"]>>,
  snapshot: DaemonSnapshotProbe,
  agents: AgentsStatus,
  now: Date,
  activeVersion: string | null,
): Promise<WorkspacesStatus> {
  if (!bindingsLoad.ok) return { readable: false, error: bindingsLoad.error };
  const runtimeByWorkspace = new Map(
    snapshot.reachable ? snapshot.runtimes.map((runtime) => [runtime.workspaceId, runtime]) : [],
  );
  const slugs = await ports.readWorkspaceSlugs();
  const osJobPidByWorkspace = new Map(
    agents.workspaces.map((workspace) => [workspace.workspaceId, workspace.workspaceJobPid]),
  );
  return {
    readable: true,
    workspaces: await Promise.all(
      bindingsLoad.bindings.map(async (binding) => {
        const runtime = runtimeByWorkspace.get(binding.workspaceId);
        const snapshotPid = runtime && runtime.processId > 0 ? runtime.processId : null;
        // The Coordinator's snapshot reports 0 for a live Workspace daemon whose handshake it
        // cannot verify (another build's daemon mid-upgrade, a socket not open yet), and is
        // absent while the Coordinator is unreachable. The OS job's own PID, read from the same
        // job listing Agents already uses, is the fallback - and the report says which source it
        // came from rather than silently picking one.
        const osJobPid = osJobPidByWorkspace.get(binding.workspaceId) ?? null;
        const pid = snapshotPid ?? osJobPid;
        const pidSource =
          snapshotPid !== null ? "daemon-snapshot" : osJobPid !== null ? "os-job" : null;
        const [health, handshake, workspaceLock, memory] = await Promise.all([
          ports.readWorkspaceHealth(binding.workspaceId),
          pid === null
            ? Promise.resolve(null)
            : ports.readWorkspaceHandshake
              ? ports.readWorkspaceHandshake(binding.workspaceId)
              : ports
                  .readCloudConnection(binding.workspaceId)
                  .then(
                    (
                      cloudConnection,
                    ): { version?: string; cloudConnection: typeof cloudConnection } => ({
                      cloudConnection,
                    }),
                  ),
          ports.readWorkspaceLock
            ? ports.readWorkspaceLock(binding.workspaceId).catch(() => null)
            : Promise.resolve(null),
          pid !== null && ports.sampleProcessMemory
            ? ports.sampleProcessMemory(pid).catch(() => undefined)
            : Promise.resolve(undefined),
        ]);
        const running = pid !== null;
        const cloudConnection = handshake?.cloudConnection ?? null;
        const version = handshake?.version;
        const versionSkew =
          version !== undefined && activeVersion !== null && version !== activeVersion;
        const lockContended =
          workspaceLock?.held === true &&
          (!running || (workspaceLock.holderPid !== null && workspaceLock.holderPid !== pid));
        return {
          workspaceId: binding.workspaceId,
          workspaceSlug: slugs.get(binding.workspaceId) ?? null,
          serverHttpUrl: binding.serverHttpUrl ?? null,
          enabled: binding.enabled,
          running,
          pid,
          pidSource,
          pending: pendingRequestsFor(binding),
          unsettledUpgrades: unsettledUpgradesFor(binding, now),
          health,
          ...(health.status === "parked" &&
          health.reason === "credential_revoked" &&
          binding.computerId
            ? { [statusRecoveryComputerId]: binding.computerId }
            : {}),
          cloudConnection,
          ...(version ? { version } : {}),
          ...(versionSkew ? { versionSkew: true as const } : {}),
          ...(lockContended ? { lockContention: { holderPid: workspaceLock.holderPid } } : {}),
          ...(memory ? { memory } : {}),
          ...(runtime?.underWay ? { underWay: true as const } : {}),
          ...(binding.lastFailure
            ? {
                lastFailure: {
                  ...binding.lastFailure,
                  at: new Date(binding.lastFailure.at).toISOString(),
                },
              }
            : {}),
        };
      }),
    ),
  };
}

function pendingRequestsFor(binding: StatusBinding): PendingRequest[] {
  const pending: PendingRequest[] = [];
  if (binding.restart) {
    pending.push({
      kind: "restart",
      requestId: binding.restart.requestId,
      phase: binding.restart.phase,
    });
  }
  for (const request of binding.upgradeRequests ?? []) {
    pending.push({
      kind: "upgrade",
      requestId: request.requestId,
      expectedVersion: request.expectedVersion,
    });
  }
  return pending;
}

/** Every Computer upgrade operation this binding still owes a settlement or a server report -
 * i.e. everything except `acknowledged`, which is audit-only history. Read-only, matching
 * `status`'s contract: this never settles, expires, or acknowledges anything itself. */
function unsettledUpgradesFor(binding: StatusBinding, now: Date): UnsettledUpgradeOperation[] {
  return (binding.upgradeOperations ?? [])
    .filter((operation) => operation.state !== "acknowledged")
    .map((operation) => ({
      requestId: operation.requestId,
      expectedVersion: operation.expectedVersion,
      state: operation.state as "pending" | "succeeded" | "failed",
      ...(operation.state === "failed" && operation.terminal?.errorCode
        ? { errorCode: operation.terminal.errorCode }
        : {}),
      ageMs: Math.max(0, now.getTime() - operation.requestedAt),
    }));
}

async function collectAgents(
  ports: StatusPorts,
  bindingsLoad: Awaited<ReturnType<StatusPorts["loadBindings"]>>,
) {
  // "supported" describes the platform's capability (does a cheap job-listing helper exist at
  // all), never whether bindings happened to load this time - conflating the two would report
  // "not supported on this platform" for an unrelated bindings.json read failure.
  if (!ports.listWorkspaceAgents.supported || !bindingsLoad.ok) {
    return { supported: ports.listWorkspaceAgents.supported, workspaces: [] };
  }
  return {
    supported: true,
    workspaces: await ports.listWorkspaceAgents.list(bindingsLoad.bindings),
  };
}

async function collectLeftoverJobs(ports: StatusPorts) {
  if (!ports.listLeftoverUpgradeJobs.supported) return { supported: false, jobs: [] };
  return { supported: true, jobs: await ports.listLeftoverUpgradeJobs.list() };
}

async function collectProcJobs(ports: StatusPorts) {
  if (!ports.listProcJobs?.supported) return { supported: false, jobs: [] };
  const jobs = await ports.listProcJobs.list().catch(() => []);
  return {
    supported: true,
    jobs: jobs.map(
      ({ id, workspaceId, agentId, name, pid, status, startedAt, memory, ownership }) => ({
        id,
        workspaceId,
        agentId,
        name,
        pid,
        status,
        startedAt,
        ...(memory && {
          memory: {
            mode: memory.mode,
            limitBytes: memory.limitBytes,
            ...(memory.usageBytes === undefined ? {} : { usageBytes: memory.usageBytes }),
          },
        }),
        ...(ownership && { ownership }),
      }),
    ),
  };
}
