import { afterEach, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  readUpgradeActivation,
  snapshotUpgradeBindings,
  readUpgradeProgressFile,
  writeUpgradeProgressFile,
  upgradeReadyReceiptDirectory,
  upgradeReadyReceiptName,
  type UpgradeActivation,
} from "../src/platform/computer-upgrade-progress";
import { DaemonConfigStore } from "../src/persistence/daemon-config";
import { MachineSupervisor, type ManagedBinding } from "../src/supervisor/machine-supervisor";
import { workspaceUpgradeRecovery } from "../src/supervisor/workspace-upgrade-recovery";
import { UpgradeProgressReporter } from "../src/daemon-runtime/upgrade-progress-reporter";
import {
  cleanupFixtures,
  fixture,
  runWorkspaceActivation,
  spawnWorkspaceActivation,
  workspaceActivationResult,
  workspaceIdentity,
} from "./computer-upgrade-progress-fixture";

afterEach(cleanupFixtures);

const journalName = "installer-transaction.json";

test("workspace processes can recover the same activation after a process exits or another binding fails to save", async () => {
  const { installRoot, directory, context, requestId, version, stateDirectory } = await fixture();
  const alphaState = join(stateDirectory, "alpha");
  const betaState = join(stateDirectory, "beta");
  const alpha = new DaemonConfigStore(alphaState);
  const beta = new DaemonConfigStore(betaState);
  const connection = {
    workspaceId: crypto.randomUUID(),
    computerId: crypto.randomUUID(),
    workspaceRoot: stateDirectory,
  };
  await alpha.save(connection);
  await writeFile(betaState, "blocked");
  await writeUpgradeProgressFile(installRoot, journalName, { request_id: requestId, to: version });
  expect(await runWorkspaceActivation(installRoot, version, alphaState)).toBeNull();
  const activatedAt = Date.now() - 10_000;
  await writeUpgradeProgressFile(directory, "activated.json", {
    kind: "activated",
    generation: context.generation,
    version,
    at: activatedAt,
  });
  const activation = {
    observedUpgradeRequestId: requestId,
    upgradeActivationGeneration: context.generation,
  };
  expect(await readUpgradeActivation(installRoot, version, activatedAt - 1)).toBeUndefined();
  expect(await readUpgradeActivation(installRoot, "1.0.0", Date.now())).toBeUndefined();
  expect(await runWorkspaceActivation(installRoot, version, alphaState)).toEqual(activation);
  await expect(beta.save({ ...connection, workspaceId: crypto.randomUUID() })).rejects.toThrow();
  await writeUpgradeProgressFile(directory, "healthy.json", {
    kind: "healthy",
    generation: context.generation,
    version,
    at: Date.now(),
  });
  await rm(betaState);
  await beta.save({ ...connection, workspaceId: crypto.randomUUID() });
  expect(await runWorkspaceActivation(installRoot, version, betaState)).toEqual(activation);
  expect(await runWorkspaceActivation(installRoot, version, alphaState)).toEqual(activation);

  const completedAt = Date.now();
  await writeUpgradeProgressFile(directory, "receipt.json", {
    kind: "receipt",
    outcome: "promoted",
    generation: context.generation,
    version,
    at: completedAt,
  });
  expect(await runWorkspaceActivation(installRoot, version, alphaState)).toBeNull();
  await rm(join(installRoot, journalName));
  expect(await readUpgradeActivation(installRoot, version, completedAt - 1)).toEqual(activation);
  expect(await runWorkspaceActivation(installRoot, version, alphaState)).toBeNull();
  await rm(join(directory, "receipt.json"));
  expect(await readUpgradeActivation(installRoot, version, completedAt - 1)).toBeUndefined();
});

async function persistFixtureReady(
  installRoot: string,
  stateDirectory: string,
  workspaceId: string,
  activation: UpgradeActivation,
) {
  const abort = new AbortController();
  try {
    await new UpgradeProgressReporter({
      installRoot,
      stateDirectory,
      workspaceId,
      endpoint: new URL("http://127.0.0.1"),
      apiKey: "fixture",
      signal: abort.signal,
    }).acceptReceipt("fixture-signed-ready", activation);
  } finally {
    abort.abort();
  }
}

for (const mode of [
  "same Coordinator",
  "restarted Coordinator",
  "workspace exit before cloud ready",
  "first workspace exit before cloud ready",
  "workspace exit with the same Coordinator",
  "adopted independent workspace",
  "adopted independent workspace after interrupted authorization",
  "adopted authorized workspace",
  "adopted workspace before confirmation",
  "adopted workspace with different invocation",
  "explicit stop",
  "detach and rebind",
] as const) {
  test(`failed workspace recovery after Installer settlement with ${mode}`, async () => {
    const { installRoot, directory, context, requestId, version, stateDirectory } = await fixture();
    const alpha = {
      workspaceId: "alpha",
      computerId: "computer",
      workspaceRoot: stateDirectory,
      enabled: true,
      serverHttpUrl: "https://fixture.example",
    };
    const beta = { ...alpha, workspaceId: "beta" };
    const pathFor = (id: string) => join(stateDirectory, id);
    const activation = {
      observedUpgradeRequestId: requestId,
      upgradeActivationGeneration: context.generation,
    };
    await mkdir(stateDirectory);
    const initialExit = mode === "first workspace exit before cloud ready";
    if (!initialExit) await writeFile(pathFor(beta.workspaceId), "blocked");
    const evidence = { generation: context.generation, version, at: Date.now() - 10_000 };
    await writeUpgradeProgressFile(installRoot, journalName, {
      request_id: requestId,
      to: version,
    });
    await writeUpgradeProgressFile(directory, "activated.json", { ...evidence, kind: "activated" });
    await snapshotUpgradeBindings(installRoot, requestId, async () =>
      [alpha, beta].map((binding) => ({
        ...binding,
        processId: 1,
        instanceId: "previous",
        version,
      })),
    );
    const children = new Map<string, ReturnType<typeof spawnWorkspaceActivation>>();
    const adopted = new Map<string, ReturnType<typeof spawnWorkspaceActivation>>();
    const invocations = new WeakMap<ReturnType<typeof spawnWorkspaceActivation>, string>();
    const interruptedBeforeLaunch =
      mode === "adopted independent workspace after interrupted authorization";
    const interrupted =
      mode === "adopted workspace before confirmation" ||
      mode === "adopted workspace with different invocation";
    let bindings: ManagedBinding[] = [alpha, beta];
    async function createCoordinator(
      startedAt: number,
      interrupt?: "before launch" | "after handshake",
    ) {
      const recovery = await workspaceUpgradeRecovery(installRoot, version, startedAt);
      const live = new Map<string, string>();
      const supervisor = new MachineSupervisor(
        {
          load: async () => bindings,
          save: async (next) => {
            bindings = next;
          },
        },
        {
          start(binding, options) {
            const path = pathFor(binding.workspaceId);
            return recovery.start(binding, options?.reconciling === true, path, async (launch) => {
              await new DaemonConfigStore(path).save(binding);
              let child = adopted.get(binding.workspaceId);
              if (!child) {
                await launch?.beforeLaunch();
                if (interrupt === "before launch" && binding.workspaceId === beta.workspaceId)
                  throw new Error("fixture Coordinator exited before launch");
                child = spawnWorkspaceActivation(installRoot, version, path);
              }
              children.set(binding.workspaceId, child);
              const invocationId = invocations.get(child) ?? crypto.randomUUID();
              invocations.set(child, invocationId);
              await launch?.observeLaunch({ mainPid: child.pid, invocationId });
              const identity = await workspaceIdentity(path, child.pid).catch((error) => {
                child.kill();
                throw error;
              });
              const { daemonId } = identity;
              if (interrupt === "after handshake" && binding.workspaceId === beta.workspaceId)
                throw new Error("fixture Coordinator exited after handshake");
              live.set(binding.workspaceId, invocationId);
              return { invocationId, daemonId, processId: child.pid };
            });
          },
          async stop(binding, preserve) {
            await recovery.discard(binding.workspaceId, preserve);
            live.delete(binding.workspaceId);
          },
          instance: async (binding) => {
            const child = children.get(binding.workspaceId);
            return child?.exitCode === null && child.signalCode === null
              ? (live.get(binding.workspaceId) ?? null)
              : null;
          },
        },
      );
      return { supervisor, recovery };
    }
    const { supervisor, recovery } = await createCoordinator(Date.now() - 1000);
    const initial = supervisor.recover();
    if (initialExit) await initial;
    else await expect(initial).rejects.toThrow("Workspace recovery incomplete");
    expect(await workspaceActivationResult(children.get(alpha.workspaceId)!)).toEqual(activation);
    if (initialExit) {
      const first = children.get(beta.workspaceId)!;
      first.kill();
      await first.exited;
    } else expect(children.has(beta.workspaceId)).toBeFalse();
    await persistFixtureReady(
      installRoot,
      pathFor(alpha.workspaceId),
      alpha.workspaceId,
      activation,
    );
    expect(await recovery.pendingWorkspaceIds()).toEqual([beta.workspaceId]);

    const settled = { ...evidence, at: Date.now() };
    await writeUpgradeProgressFile(directory, "healthy.json", { ...settled, kind: "healthy" });
    await writeUpgradeProgressFile(directory, "receipt.json", {
      ...settled,
      kind: "receipt",
      outcome: "promoted",
    });
    await rm(join(installRoot, journalName));
    if (!initialExit) await rm(pathFor(beta.workspaceId));
    if (mode === "same Coordinator" || mode === "workspace exit with the same Coordinator") {
      if (mode === "workspace exit with the same Coordinator") {
        await supervisor.reconcile(await recovery.pendingWorkspaceIds());
        const failed = children.get(beta.workspaceId)!;
        failed.kill();
        await failed.exited;
      }
      await supervisor.reconcile(await recovery.pendingWorkspaceIds());
      expect(await workspaceActivationResult(children.get(beta.workspaceId)!)).toEqual(activation);
      expect(await recovery.pendingWorkspaceIds()).toEqual([beta.workspaceId]);
      await persistFixtureReady(
        installRoot,
        pathFor(beta.workspaceId),
        beta.workspaceId,
        activation,
      );
      expect(await recovery.pendingWorkspaceIds()).toEqual([]);
    } else {
      if (mode === "explicit stop") await supervisor.command("stop", beta.workspaceId);
      if (mode === "detach and rebind") {
        const detached = await supervisor.detach(beta.workspaceId, {
          credentials: { load: async () => "fixture", delete: async () => {} },
          makeSelfClient: () => ({ detach: async () => ({ ok: true, value: "key_revoked" }) }),
        });
        expect(detached.detached).toBeTrue();
      }
      if (mode === "workspace exit before cloud ready") {
        await supervisor.reconcile(await recovery.pendingWorkspaceIds());
        const failed = children.get(beta.workspaceId)!;
        const receipt = join(
          upgradeReadyReceiptDirectory(pathFor(beta.workspaceId)),
          upgradeReadyReceiptName(activation),
        );
        expect(await Bun.file(receipt).exists()).toBeFalse();
        failed.kill();
        await failed.exited;
        expect(await recovery.pendingWorkspaceIds()).toEqual([beta.workspaceId]);
      }
      await supervisor.shutdown();
      const grantPath = join(
        directory,
        `workspace-recovery-${Buffer.from(beta.workspaceId).toString("base64url")}.json`,
      );
      if (interruptedBeforeLaunch) {
        const authorizing = await createCoordinator(Date.now(), "before launch");
        await expect(authorizing.supervisor.recover()).rejects.toThrow(
          "Workspace recovery incomplete",
        );
        expect(await readUpgradeProgressFile(grantPath)).toMatchObject({ state: "armed" });
        expect(children.has(beta.workspaceId)).toBeFalse();
        await workspaceActivationResult(children.get(alpha.workspaceId)!);
      }
      if (mode === "adopted independent workspace" || interruptedBeforeLaunch) {
        const betaPath = pathFor(beta.workspaceId);
        await new DaemonConfigStore(betaPath).save(beta);
        const child = spawnWorkspaceActivation(installRoot, version, betaPath);
        await workspaceIdentity(betaPath, child.pid);
        adopted.set(beta.workspaceId, child);
      }
      if (mode === "adopted authorized workspace" || interrupted) {
        const authorizing = await createCoordinator(
          Date.now(),
          interrupted ? "after handshake" : undefined,
        );
        const launch = authorizing.supervisor.recover();
        if (interrupted) await expect(launch).rejects.toThrow("Workspace recovery incomplete");
        else await launch;
        const child = children.get(beta.workspaceId)!;
        await workspaceIdentity(pathFor(beta.workspaceId), child.pid);
        if (interrupted) {
          expect(await readUpgradeProgressFile(grantPath)).toMatchObject({
            state: "launched",
            launch: { mainPid: child.pid, invocationId: invocations.get(child) },
          });
        }
        if (mode === "adopted workspace with different invocation")
          invocations.set(child, crypto.randomUUID());
        adopted.set(beta.workspaceId, child);
        await workspaceActivationResult(children.get(alpha.workspaceId)!);
      }
      const restarted = await createCoordinator(Date.now());
      await restarted.supervisor.recover();
      expect(await workspaceActivationResult(children.get(alpha.workspaceId)!)).toBeNull();
      if (mode === "explicit stop") {
        expect(children.has(beta.workspaceId)).toBeFalse();
        await restarted.supervisor.command("start", beta.workspaceId);
      }
      if (mode === "detach and rebind") {
        expect(children.has(beta.workspaceId)).toBeFalse();
        await restarted.supervisor.configure(beta);
      }
      const betaActivation = await workspaceActivationResult(children.get(beta.workspaceId)!);
      const restored =
        mode === "restarted Coordinator" ||
        mode === "workspace exit before cloud ready" ||
        mode === "adopted authorized workspace" ||
        mode === "adopted workspace before confirmation" ||
        initialExit;
      expect(betaActivation).toEqual(restored ? activation : null);
      if (interrupted || interruptedBeforeLaunch) {
        expect(await readUpgradeProgressFile(grantPath)).toMatchObject({
          state: interruptedBeforeLaunch ? "armed" : restored ? "confirmed" : "launched",
        });
      }
      if (restored)
        await persistFixtureReady(
          installRoot,
          pathFor(beta.workspaceId),
          beta.workspaceId,
          activation,
        );
      expect(await restarted.recovery.pendingWorkspaceIds()).toEqual(
        mode === "adopted independent workspace" ||
          interruptedBeforeLaunch ||
          mode === "adopted workspace with different invocation"
          ? [beta.workspaceId]
          : [],
      );
    }
    if (mode === "workspace exit before cloud ready") {
      const afterReady = await createCoordinator(Date.now());
      await afterReady.supervisor.recover();
      expect(await workspaceActivationResult(children.get(alpha.workspaceId)!)).toBeNull();
      expect(await workspaceActivationResult(children.get(beta.workspaceId)!)).toBeNull();
      expect(await afterReady.recovery.pendingWorkspaceIds()).toEqual([]);
    }
    expect(
      await runWorkspaceActivation(installRoot, version, pathFor(alpha.workspaceId)),
    ).toBeNull();
    if (!interruptedBeforeLaunch) {
      expect(
        await runWorkspaceActivation(installRoot, version, pathFor(beta.workspaceId)),
      ).toBeNull();
    }
  });
}

test("the drain snapshot preserves running, stopped and unconfirmed workspaces", async () => {
  const { installRoot, directory, requestId, workspaceId, version } = await fixture();
  const workspace = {
    workspaceId,
    computerId: "computer",
    processId: 1,
    enabled: true,
    instanceId: "worker",
    version,
  };
  await snapshotUpgradeBindings(installRoot, requestId, async () => [
    workspace,
    { ...workspace, workspaceId: "stopped", enabled: false, processId: 0 },
    { ...workspace, workspaceId: "starting", lifecycleUnderWay: true, processId: 0 },
  ]);
  const snapshot = await Bun.file(join(directory, "snapshot.json")).json();
  expect(snapshot.bindings).toEqual([
    { workspaceId, state: "running" },
    { workspaceId: "stopped", state: "stopped" },
    { workspaceId: "starting", state: "unknown" },
  ]);
});
