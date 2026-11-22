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
import { DaemonConfigStore } from "../src/persistence/daemon-config";
import { UpgradeProgressReporter } from "../src/daemon-runtime/upgrade-progress-reporter";

const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "coforge-upgrade-progress-"));
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

async function runWorkspaceActivation(
  installRoot: string,
  version: string,
  stateDirectory: string,
) {
  const path = import.meta.resolve("../src/platform/computer-upgrade-progress.ts");
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `const { readUpgradeActivation } = await import(${JSON.stringify(path)});
       const [root, version, state] = Bun.argv.slice(-3);
       await Bun.file(state + "/config.json").json();
       console.log(JSON.stringify((await readUpgradeActivation(root, version, performance.timeOrigin)) ?? null));`,
      installRoot,
      version,
      stateDirectory,
    ],
    { stdout: "pipe", stderr: "inherit" },
  );
  const output = await new Response(child.stdout).json();
  expect(await child.exited).toBe(0);
  return output;
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
