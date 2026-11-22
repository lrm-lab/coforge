import { rm } from "node:fs/promises";
import { join } from "node:path";
import { LocalDaemonLauncher } from "#src/daemon-host/launcher";
import {
  computerUpgradeProgressRoot,
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
} & (
  | { state: "failed" }
  | { state: "armed"; armedAt: number }
  | { state: "confirmed"; armedAt: number; daemon: { processId: number; daemonId: string } }
);

type RecoveryAttempt = {
  activation: UpgradeActivation;
  directory: string;
  expiresAt: number;
};

function recoveryFile(workspaceId: string) {
  return `workspace-recovery-${Buffer.from(workspaceId).toString("base64url")}.json`;
}

async function readRecoveryAttempt(
  installRoot: string,
  version: string,
): Promise<RecoveryAttempt | undefined> {
  const latest = await readUpgradeProgressFile<{ requestId: string }>(
    join(computerUpgradeProgressRoot(installRoot), "latest.json"),
  );
  if (!latest) return;
  const attempt = await readLocalUpgradeContext(installRoot, latest.requestId);
  if (!attempt || attempt.context.version !== version) return;
  const activated = await readUpgradeProgressFile<{
    kind: string;
    generation: string;
    version: string;
  }>(join(attempt.directory, "activated.json"));
  if (
    activated?.kind !== "activated" ||
    activated.generation !== attempt.context.generation ||
    activated.version !== version
  )
    return;
  return {
    activation: {
      observedUpgradeRequestId: latest.requestId,
      upgradeActivationGeneration: attempt.context.generation,
    },
    directory: attempt.directory,
    expiresAt: attempt.context.expiresAt,
  };
}

function sameActivation(left: UpgradeActivation, right: UpgradeActivation) {
  return (
    left.observedUpgradeRequestId === right.observedUpgradeRequestId &&
    left.upgradeActivationGeneration === right.upgradeActivationGeneration
  );
}

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
  const attempt = await readRecoveryAttempt(installRoot, version);
  if (!attempt) return new WorkspaceUpgradeRecovery(version);
  const activation = await readUpgradeActivation(installRoot, version, startedAt);
  const snapshot = await readUpgradeProgressFile<{
    generation: string;
    version: string;
    bindings: { workspaceId: string; state: string }[];
  }>(join(attempt.directory, "snapshot.json"));
  const workspaces =
    snapshot?.generation === attempt.activation.upgradeActivationGeneration &&
    snapshot.version === version &&
    Array.isArray(snapshot.bindings)
      ? snapshot.bindings
          .filter(({ state }) => state === "running")
          .map(({ workspaceId }) => workspaceId)
      : [];
  return new WorkspaceUpgradeRecovery(
    version,
    attempt,
    workspaces,
    !!activation && sameActivation(activation, attempt.activation),
  );
}

export class WorkspaceUpgradeRecovery {
  readonly #original: Set<string>;
  readonly #eligible: Set<string>;
  readonly #failed = new Set<string>();

  constructor(
    private readonly version: string,
    private readonly attempt?: RecoveryAttempt,
    workspaces: string[] = [],
    activatedAtStartup = false,
  ) {
    this.#original = new Set(workspaces);
    this.#eligible = new Set(activatedAtStartup ? workspaces : []);
  }

  pendingWorkspaceIds() {
    return this.attempt && this.attempt.expiresAt > Date.now() ? [...this.#failed] : [];
  }

  async discard(workspaceId: string, preserve?: true) {
    if (preserve) return;
    this.#eligible.delete(workspaceId);
    this.#failed.delete(workspaceId);
    if (this.attempt && this.#original.has(workspaceId))
      await rm(join(this.attempt.directory, recoveryFile(workspaceId)), { force: true }).catch(
        () => {},
      );
  }

  async start(
    binding: ManagedBinding,
    reconciling: boolean,
    run: (arm: () => Promise<void>) => Promise<{
      invocationId: string;
      processId: number;
      daemonId: string;
    }>,
  ): Promise<string> {
    const { workspaceId } = binding;
    const attempt = this.attempt;
    if (
      !reconciling ||
      binding.detachConfirmed ||
      !attempt ||
      attempt.expiresAt <= Date.now() ||
      !this.#original.has(workspaceId)
    ) {
      await this.discard(workspaceId);
      return (await run(async () => {})).invocationId;
    }
    const name = recoveryFile(workspaceId);
    const record = await readUpgradeProgressFile<RecoveryLaunch>(join(attempt.directory, name));
    const matches =
      !!record?.binding &&
      !!record.activation &&
      sameBinding(record.binding, binding) &&
      sameActivation(record.activation, attempt.activation) &&
      record.version === this.version;
    const retry = matches && (record.state === "failed" || record.state === "armed");
    const firstRecovery = this.#eligible.delete(workspaceId);
    if (!retry && (record || !firstRecovery)) {
      this.#failed.delete(workspaceId);
      if (record && !matches) await this.discard(workspaceId);
      return (await run(async () => {})).invocationId;
    }
    const evidence = {
      binding: {
        workspaceId,
        computerId: binding.computerId,
        serverHttpUrl: binding.serverHttpUrl,
      },
      version: this.version,
      activation: attempt.activation,
    };
    let armedAt: number | undefined;
    try {
      const { invocationId, processId, daemonId } = await run(async () => {
        if (!retry) return;
        const now = Date.now();
        await writeUpgradeProgressFile(attempt.directory, name, {
          ...evidence,
          state: "armed",
          armedAt: now,
        } satisfies RecoveryLaunch).then(
          () => {
            armedAt = now;
          },
          () => {},
        );
      });
      if (armedAt !== undefined) {
        await writeUpgradeProgressFile(attempt.directory, name, {
          ...evidence,
          state: "confirmed",
          armedAt,
          daemon: { processId, daemonId },
        } satisfies RecoveryLaunch).catch(() => {});
      }
      this.#failed.delete(workspaceId);
      return invocationId;
    } catch (error) {
      await writeUpgradeProgressFile(attempt.directory, name, {
        ...evidence,
        state: "failed",
      } satisfies RecoveryLaunch).then(
        () => this.#failed.add(workspaceId),
        () => {},
      );
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
  const attempt = await readRecoveryAttempt(installRoot, version);
  if (!attempt) return;
  const path = join(attempt.directory, recoveryFile(binding.workspaceId));
  const deadline = Math.min(Date.now() + 3_000, attempt.expiresAt);
  while (!signal.aborted && Date.now() < deadline) {
    const grant = await readUpgradeProgressFile<RecoveryLaunch>(path);
    if (
      !grant ||
      grant.state === "failed" ||
      grant.version !== version ||
      !grant.binding ||
      !grant.activation ||
      !sameBinding(grant.binding, binding) ||
      !sameActivation(grant.activation, attempt.activation) ||
      !Number.isFinite(grant.armedAt) ||
      grant.armedAt > startedAt
    )
      return;
    if (grant.state === "confirmed") {
      if (grant.daemon?.processId !== process.pid) return;
      const own = await new LocalDaemonLauncher({
        executablePath: process.execPath,
        socketPath: join(directory, "daemon.sock"),
        spawn: () => {},
      })
        .identity(1_000)
        .catch(() => undefined);
      if (own?.processId === process.pid && own.daemonId === grant.daemon.daemonId)
        return grant.activation;
      return;
    }
    await Bun.sleep(25);
  }
}
