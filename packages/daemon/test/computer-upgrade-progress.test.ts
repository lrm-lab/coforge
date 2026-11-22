import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  beginLocalUpgradeProgress,
  readUpgradeActivation,
  readLocalUpgradeContext,
  snapshotUpgradeBindings,
  writeUpgradeProgressFile,
} from "../src/platform/computer-upgrade-progress";
import { LocalDaemonLauncher } from "../src/daemon-host/launcher";
import { DaemonConfigStore } from "../src/persistence/daemon-config";
import { MachineSupervisor, type ManagedBinding } from "../src/supervisor/machine-supervisor";
import { workspaceUpgradeRecovery } from "../src/supervisor/workspace-upgrade-recovery";
import { UpgradeProgressReporter } from "../src/daemon-runtime/upgrade-progress-reporter";

const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cf-upgrade-"));
  scratch.push(root);
  const installRoot = join(root, "install");
  const stateDirectory = join(root, "daemon");
  await mkdir(installRoot);
  const requestId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  const version = "2.0.0";
  await beginLocalUpgradeProgress(installRoot, workspaceId, requestId, version);
  const local = await readLocalUpgradeContext(installRoot, requestId);
  if (!local) throw new Error("progress context missing");
  return { installRoot, stateDirectory, requestId, workspaceId, version, ...local };
}

const journalName = "installer-transaction.json";

function spawnWorkspaceActivation(installRoot: string, version: string, stateDirectory: string) {
  const recovery = import.meta.resolve("../src/supervisor/workspace-upgrade-recovery.ts");
  const localRpc = import.meta.resolve("../src/local-rpc.ts");
  return Bun.spawn(
    [
      process.execPath,
      "--eval",
      `const { readWorkspaceUpgradeActivation } = await import(${JSON.stringify(recovery)});
       const { startDaemonLocalRpcServer } = await import(${JSON.stringify(localRpc)});
       const { join } = await import("node:path");
       const [root, version, state] = Bun.argv.slice(-3);
       const binding = await Bun.file(join(state, "config.json")).json();
       const server = await startDaemonLocalRpcServer({
         socketPath: join(state, "daemon.sock"), version, validateCredential: () => false,
         runtime: {}, credentials: {},
       });
       try {
         if (await new Response(Bun.stdin.stream()).text() !== "start") throw new Error("missing fixture start");
         const activation = await readWorkspaceUpgradeActivation(root, state, binding, version, performance.timeOrigin, new AbortController().signal);
         console.log(JSON.stringify(activation ?? null));
       } finally {
         await server.close();
       }`,
      installRoot,
      version,
      stateDirectory,
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "inherit" },
  );
}

async function workspaceActivationResult(child: ReturnType<typeof spawnWorkspaceActivation>) {
  child.stdin.write("start");
  child.stdin.end();
  const output = await new Response(child.stdout).json();
  expect(await child.exited).toBe(0);
  return output;
}

function runWorkspaceActivation(installRoot: string, version: string, directory: string) {
  return workspaceActivationResult(spawnWorkspaceActivation(installRoot, version, directory));
}

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

for (const mode of [
  "same Coordinator",
  "restarted Coordinator",
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
    await writeFile(pathFor(beta.workspaceId), "blocked");
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
    let bindings: ManagedBinding[] = [alpha, beta];
    async function createCoordinator(startedAt: number) {
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
            return recovery.start(binding, options?.reconciling === true, async (arm) => {
              await new DaemonConfigStore(path).save(binding);
              await arm();
              const child = spawnWorkspaceActivation(installRoot, version, path);
              children.set(binding.workspaceId, child);
              const launcher = new LocalDaemonLauncher({
                executablePath: process.execPath,
                socketPath: join(path, "daemon.sock"),
                spawn: () => {},
              });
              const until = Date.now() + 3_000;
              let identity;
              while (!identity && Date.now() < until) {
                identity = await launcher.identity(100).catch(() => undefined);
                if (!identity) await Bun.sleep(25);
              }
              if (!identity || identity.processId !== child.pid) {
                child.kill();
                throw new Error("fixture Workspace handshake missing");
              }
              const { daemonId } = identity;
              const invocationId = crypto.randomUUID();
              live.set(binding.workspaceId, invocationId);
              return { invocationId, daemonId, processId: child.pid };
            });
          },
          async stop(binding, preserve) {
            await recovery.discard(binding.workspaceId, preserve);
            live.delete(binding.workspaceId);
          },
          instance: async (binding) => live.get(binding.workspaceId) ?? null,
        },
      );
      return { supervisor, recovery };
    }
    const { supervisor, recovery } = await createCoordinator(Date.now() - 1000);
    await expect(supervisor.recover()).rejects.toThrow("Workspace recovery incomplete");
    expect(await workspaceActivationResult(children.get(alpha.workspaceId)!)).toEqual(activation);
    expect(children.has(beta.workspaceId)).toBeFalse();
    expect(recovery.pendingWorkspaceIds()).toEqual([beta.workspaceId]);

    const settled = { ...evidence, at: Date.now() };
    await writeUpgradeProgressFile(directory, "healthy.json", { ...settled, kind: "healthy" });
    await writeUpgradeProgressFile(directory, "receipt.json", {
      ...settled,
      kind: "receipt",
      outcome: "promoted",
    });
    await rm(join(installRoot, journalName));
    await rm(pathFor(beta.workspaceId));
    if (mode === "same Coordinator") {
      await supervisor.reconcile(recovery.pendingWorkspaceIds());
      expect(await workspaceActivationResult(children.get(beta.workspaceId)!)).toEqual(activation);
      expect(recovery.pendingWorkspaceIds()).toEqual([]);
    } else {
      if (mode === "explicit stop") await supervisor.command("stop", beta.workspaceId);
      if (mode === "detach and rebind") {
        const detached = await supervisor.detach(beta.workspaceId, {
          credentials: { load: async () => "fixture", delete: async () => {} },
          makeSelfClient: () => ({ detach: async () => ({ ok: true, value: "key_revoked" }) }),
        });
        expect(detached.detached).toBeTrue();
      }
      await supervisor.shutdown();
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
      expect(betaActivation).toEqual(mode === "restarted Coordinator" ? activation : null);
      expect(restarted.recovery.pendingWorkspaceIds()).toEqual([]);
    }
    expect(
      await runWorkspaceActivation(installRoot, version, pathFor(alpha.workspaceId)),
    ).toBeNull();
    expect(
      await runWorkspaceActivation(installRoot, version, pathFor(beta.workspaceId)),
    ).toBeNull();
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

test("a rejected detail write leaves the signed ready receipt available to the next process", async () => {
  const { installRoot, stateDirectory, workspaceId } = await fixture();
  const unavailable = Promise.withResolvers<void>();
  const delivered = Promise.withResolvers<unknown>();
  let first = true;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const body = await request.json();
      if (first) {
        first = false;
        unavailable.resolve();
        return new Response(null, { status: 503 });
      }
      delivered.resolve(body);
      return new Response(null, { status: 204 });
    },
  });
  const stopped = new AbortController();
  const resumed = new AbortController();
  const options = {
    installRoot,
    stateDirectory,
    workspaceId,
    endpoint: server.url,
    apiKey: "fixture",
  };
  try {
    const before = new UpgradeProgressReporter({ ...options, signal: stopped.signal });
    await before.acceptReceipt("fixture-ready-authorization");
    await unavailable.promise;
    stopped.abort();
    const after = new UpgradeProgressReporter({ ...options, signal: resumed.signal });
    await after.resume([]);
    expect(await delivered.promise).toEqual({
      kind: "ready",
      receipt: "fixture-ready-authorization",
    });
  } finally {
    stopped.abort();
    resumed.abort();
    await server.stop(true);
  }
});

test("the origin reporter sends a later recovery without replacing the original receipt", async () => {
  const { installRoot, stateDirectory, workspaceId, directory, context, version, requestId } =
    await fixture();
  const original = {
    kind: "receipt",
    outcome: "unresolved",
    generation: context.generation,
    version,
    at: Date.now(),
  };
  const recovery = {
    ...original,
    outcome: "rolled_back",
    restoredVersion: "1.0.0",
    at: original.at + 1,
  };
  const firstPost = Promise.withResolvers<unknown>();
  const secondPost = Promise.withResolvers<unknown>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const body = await request.json();
      const events = (body as { events?: { outcome?: string }[] }).events;
      if (events?.some((event) => event.outcome === "rolled_back")) secondPost.resolve(body);
      else firstPost.resolve(body);
      return new Response(null, { status: 204 });
    },
  });
  const abort = new AbortController();
  try {
    const reporter = new UpgradeProgressReporter({
      installRoot,
      stateDirectory,
      workspaceId,
      endpoint: server.url,
      apiKey: "fixture",
      signal: abort.signal,
    });
    await writeUpgradeProgressFile(directory, "receipt.json", original);
    await reporter.resume([]);
    expect(await firstPost.promise).toEqual({
      kind: "machine",
      requestId,
      events: [original],
    });
    await writeUpgradeProgressFile(directory, "recovery.json", recovery);
    expect(await secondPost.promise).toEqual({
      kind: "machine",
      requestId,
      events: [recovery],
    });
  } finally {
    abort.abort();
    await server.stop(true);
  }
});
