import { rm } from "node:fs/promises";
import { join } from "node:path";
import { LocalDaemonLauncher } from "#src/daemon-host/launcher";
import {
  readLocalUpgradeContext,
  readUpgradeActivation,
  readUpgradeProgressFile,
  writeUpgradeProgressFile,
  type UpgradeActivation,
} from "#src/platform/computer-upgrade-progress";
import type { ManagedBinding } from "./machine-supervisor";

type Binding = Pick<ManagedBinding, "workspaceId" | "computerId" | "serverHttpUrl">;
type RecoveryLaunch = {
  binding: Binding;
  version: string;
  activation: UpgradeActivation;
  armedAt: number;
  daemon?: { processId: number; daemonId: string };
};
const GRANT_FILE = "upgrade-recovery-launch.json";

function sameBinding(left: Binding, right: Binding) {
  return (
    left.workspaceId === right.workspaceId &&
    left.computerId === right.computerId &&
    left.serverHttpUrl === right.serverHttpUrl
  );
}

export async function workspaceUpgradeRecovery(
  installRoot: string,
  version: string,
  startedAt: number,
) {
  const activation = await readUpgradeActivation(installRoot, version, startedAt);
  if (!activation) return new WorkspaceUpgradeRecovery(version);
  const attempt = await readLocalUpgradeContext(installRoot, activation.observedUpgradeRequestId);
  if (!attempt || attempt.context.generation !== activation.upgradeActivationGeneration)
    return new WorkspaceUpgradeRecovery(version);
  const snapshot = await readUpgradeProgressFile<{
    generation: string;
    version: string;
    bindings: { workspaceId: string; state: string }[];
  }>(join(attempt.directory, "snapshot.json"));
  const workspaces =
    snapshot?.generation === activation.upgradeActivationGeneration &&
    snapshot.version === version &&
    Array.isArray(snapshot.bindings)
      ? snapshot.bindings
          .filter(({ state }) => state === "running")
          .map(({ workspaceId }) => workspaceId)
      : [];
  return new WorkspaceUpgradeRecovery(version, {
    activation,
    workspaces,
    expiresAt: attempt.context.expiresAt,
  });
}

export class WorkspaceUpgradeRecovery {
  readonly #eligible: Set<string>;
  readonly #failed = new Map<string, Binding>();

  constructor(
    private readonly version: string,
    private readonly attempt?: {
      activation: UpgradeActivation;
      workspaces: string[];
      expiresAt: number;
    },
  ) {
    this.#eligible = new Set(attempt?.workspaces);
  }

  pendingWorkspaceIds() {
    return this.attempt && this.attempt.expiresAt > Date.now() ? [...this.#failed.keys()] : [];
  }

  discard(workspaceId: string) {
    this.#eligible.delete(workspaceId);
    this.#failed.delete(workspaceId);
  }

  async start(
    binding: Binding,
    reconciling: boolean,
    directory: string,
    run: (arm: () => Promise<void>) => Promise<{
      invocationId: string;
      processId: number;
      daemonId: string;
    }>,
  ): Promise<string> {
    const { workspaceId } = binding;
    const attempt = this.attempt;
    const previous = this.#failed.get(workspaceId);
    if (
      !reconciling ||
      !attempt ||
      attempt.expiresAt <= Date.now() ||
      (previous && !sameBinding(previous, binding)) ||
      (!previous && !this.#eligible.has(workspaceId))
    ) {
      this.discard(workspaceId);
      return (await run(async () => {})).invocationId;
    }
    this.#eligible.delete(workspaceId);
    let grant: RecoveryLaunch | undefined;
    try {
      const { invocationId, processId, daemonId } = await run(async () => {
        if (!previous) return;
        const pending: RecoveryLaunch = {
          binding: {
            workspaceId,
            computerId: binding.computerId,
            serverHttpUrl: binding.serverHttpUrl,
          },
          version: this.version,
          activation: attempt.activation,
          armedAt: Date.now(),
        };
        await writeUpgradeProgressFile(directory, GRANT_FILE, pending).then(
          () => {
            grant = pending;
          },
          () => {},
        );
      });
      if (grant) {
        await writeUpgradeProgressFile(directory, GRANT_FILE, {
          ...grant,
          daemon: { processId, daemonId },
        } satisfies RecoveryLaunch).catch(() => {});
      }
      this.#failed.delete(workspaceId);
      return invocationId;
    } catch (error) {
      if (grant) await rm(join(directory, GRANT_FILE), { force: true }).catch(() => {});
      this.#failed.set(workspaceId, binding);
      throw error;
    }
  }
}

export async function readWorkspaceUpgradeActivation(
  installRoot: string,
  directory: string,
  binding: Binding,
  version: string,
  startedAt: number,
  signal: AbortSignal,
) {
  return (
    (await readUpgradeActivation(installRoot, version, startedAt)) ??
    readWorkspaceUpgradeRecovery(installRoot, directory, binding, version, startedAt, signal)
  );
}

async function readWorkspaceUpgradeRecovery(
  installRoot: string,
  directory: string,
  binding: Binding,
  version: string,
  startedAt: number,
  signal: AbortSignal,
): Promise<UpgradeActivation | undefined> {
  const deadline = Date.now() + 3_000;
  while (!signal.aborted) {
    const grant = await readUpgradeProgressFile<RecoveryLaunch>(join(directory, GRANT_FILE));
    if (
      !grant ||
      grant.version !== version ||
      !grant.binding ||
      !grant.activation ||
      !sameBinding(grant.binding, binding) ||
      !Number.isFinite(grant.armedAt) ||
      grant.armedAt > startedAt
    )
      return;
    if (grant.daemon) {
      if (grant.daemon.processId !== process.pid) return;
      const own = await new LocalDaemonLauncher({
        executablePath: process.execPath,
        socketPath: join(directory, "daemon.sock"),
        spawn: () => {},
      })
        .identity(1_000)
        .catch(() => undefined);
      if (own?.processId !== process.pid || own.daemonId !== grant.daemon.daemonId) return;
      const attempt = await readLocalUpgradeContext(
        installRoot,
        grant.activation.observedUpgradeRequestId,
      );
      if (
        !attempt ||
        attempt.context.generation !== grant.activation.upgradeActivationGeneration ||
        attempt.context.version !== version
      )
        return;
      const activated = await readUpgradeProgressFile<{ kind: string; generation: string }>(
        join(attempt.directory, "activated.json"),
      );
      if (activated?.kind === "activated" && activated.generation === attempt.context.generation)
        return grant.activation;
      return;
    }
    if (Date.now() >= deadline) return;
    await Bun.sleep(25);
  }
}
