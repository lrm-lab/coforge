import { access, rm } from "node:fs/promises";
import { join } from "node:path";
import { LocalDaemonLauncher } from "#src/daemon-host/launcher";
import {
  computerUpgradeProgressRoot,
  readLocalUpgradeContext,
  readUpgradeActivation,
  readUpgradeProgressFile,
  writeUpgradeProgressFile,
  upgradeReadyReceiptDirectory,
  upgradeReadyReceiptName,
  type UpgradeActivation,
} from "#src/platform/computer-upgrade-progress";
import type { ManagedBinding } from "./machine-supervisor";
import type { NativeProcessIdentity } from "./workspace-instance";

type Binding = Pick<ManagedBinding, "workspaceId" | "computerId" | "serverHttpUrl">;
type LaunchIdentity = Pick<NativeProcessIdentity, "mainPid" | "invocationId">;
export type WorkspaceRecoveryLaunch = {
  beforeLaunch: () => Promise<void>;
  cancelAttribution: () => Promise<void>;
  observeLaunch: (identity: LaunchIdentity) => Promise<void>;
};

type RecoveryLaunch = {
  binding: Binding;
  version: string;
  activation: UpgradeActivation;
} & (
  | { state: "failed" }
  | { state: "armed"; authorizedAt: number }
  | { state: "launched"; authorizedAt: number; launch: LaunchIdentity }
  | { state: "confirmed"; authorizedAt: number; daemon: { processId: number; daemonId: string } }
);

type RecoveryAttempt = {
  activation: UpgradeActivation;
  directory: string;
  expiresAt: number;
  activatedAt: number;
};

function recoveryFile(workspaceId: string) {
  return `workspace-recovery-${Buffer.from(workspaceId).toString("base64url")}.json`;
}

function hasReadyReceipt(path: string) {
  return access(path).then(
    () => true,
    () => false,
  );
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
    at: number;
  }>(join(attempt.directory, "activated.json"));
  if (
    activated?.kind !== "activated" ||
    activated.generation !== attempt.context.generation ||
    activated.version !== version ||
    !Number.isFinite(activated.at)
  )
    return;
  return {
    activation: {
      observedUpgradeRequestId: latest.requestId,
      upgradeActivationGeneration: attempt.context.generation,
    },
    directory: attempt.directory,
    expiresAt: attempt.context.expiresAt,
    activatedAt: activated.at,
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
  readonly #pending = new Map<string, string>();

  constructor(
    private readonly version: string,
    private readonly attempt?: RecoveryAttempt,
    workspaces: string[] = [],
    activatedAtStartup = false,
  ) {
    this.#original = new Set(workspaces);
    this.#eligible = new Set(activatedAtStartup ? workspaces : []);
  }

  async pendingWorkspaceIds() {
    if (!this.attempt || this.attempt.expiresAt <= Date.now()) return [];
    await Promise.all(
      Array.from(this.#pending, async ([workspaceId, path]) => {
        if ((await hasReadyReceipt(path)) && this.#pending.get(workspaceId) === path)
          this.#pending.delete(workspaceId);
      }),
    );
    return [...this.#pending.keys()];
  }

  async discard(workspaceId: string, preserve?: true) {
    if (preserve) return;
    this.#eligible.delete(workspaceId);
    this.#pending.delete(workspaceId);
    if (this.attempt && this.#original.has(workspaceId))
      await rm(join(this.attempt.directory, recoveryFile(workspaceId)), { force: true }).catch(
        () => {},
      );
  }

  async start(
    binding: ManagedBinding,
    reconciling: boolean,
    stateDirectory: string,
    run: (recovery?: WorkspaceRecoveryLaunch) => Promise<{
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
      return (await run()).invocationId;
    }
    const name = recoveryFile(workspaceId);
    const record = await readUpgradeProgressFile<RecoveryLaunch>(join(attempt.directory, name));
    const matches =
      !!record?.binding &&
      !!record.activation &&
      sameBinding(record.binding, binding) &&
      sameActivation(record.activation, attempt.activation) &&
      record.version === this.version;
    const firstRecovery = this.#eligible.delete(workspaceId);
    const receipt = join(
      upgradeReadyReceiptDirectory(stateDirectory),
      upgradeReadyReceiptName(attempt.activation),
    );
    if ((!matches && (record || !firstRecovery)) || (await hasReadyReceipt(receipt))) {
      this.#pending.delete(workspaceId);
      if (record && !matches) await this.discard(workspaceId);
      return (await run()).invocationId;
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
    const save = (state: RecoveryLaunch) =>
      writeUpgradeProgressFile(attempt.directory, name, state).then(
        () => true,
        () => false,
      );
    if (matches || (await save({ ...evidence, state: "failed" })))
      this.#pending.set(workspaceId, receipt);
    let authorization: { authorizedAt: number; launch?: LaunchIdentity } | undefined;
    const { invocationId, processId, daemonId } = await run({
      beforeLaunch: async () => {
        if (attempt.expiresAt <= Date.now() || (await hasReadyReceipt(receipt))) return;
        const at = performance.timeOrigin + performance.now();
        if (await save({ ...evidence, state: "armed", authorizedAt: at })) {
          authorization = { authorizedAt: at };
          this.#pending.set(workspaceId, receipt);
        }
      },
      cancelAttribution: async () => {
        if (!authorization) return;
        authorization = undefined;
        await save({ ...evidence, state: "failed" });
      },
      observeLaunch: async ({ mainPid, invocationId }) => {
        if (!authorization || authorization.launch) return;
        const launch = { mainPid, invocationId };
        authorization.launch = launch;
        await save({
          ...evidence,
          state: "launched",
          authorizedAt: authorization.authorizedAt,
          launch,
        });
      },
    });
    const proof = authorization ?? (matches && record.state === "launched" ? record : undefined);
    if (proof?.launch?.mainPid === processId && proof.launch.invocationId === invocationId) {
      await save({
        ...evidence,
        state: "confirmed",
        authorizedAt: proof.authorizedAt,
        daemon: { processId, daemonId },
      });
    }
    return invocationId;
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
  const receipt = join(
    upgradeReadyReceiptDirectory(directory),
    upgradeReadyReceiptName(attempt.activation),
  );
  const deadline = Math.min(Date.now() + 3_000, attempt.expiresAt);
  while (!signal.aborted && Date.now() < deadline && !(await hasReadyReceipt(receipt))) {
    const grant = await readUpgradeProgressFile<RecoveryLaunch>(path);
    if (
      !grant ||
      grant.version !== version ||
      !grant.binding ||
      !grant.activation ||
      !sameBinding(grant.binding, binding) ||
      !sameActivation(grant.activation, attempt.activation) ||
      attempt.activatedAt >= startedAt
    )
      return;
    if (grant.state === "failed" || !(grant.authorizedAt < startedAt)) return;
    if (grant.state === "launched" && grant.launch?.mainPid !== process.pid) return;
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
