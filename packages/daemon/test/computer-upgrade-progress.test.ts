import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  beginLocalUpgradeProgress,
  claimUpgradeActivation,
  readLocalUpgradeContext,
  snapshotUpgradeBindings,
  writeUpgradeProgressFile,
} from "../src/platform/computer-upgrade-progress";
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

test("only the first target supervisor can claim the committed activation", async () => {
  const { installRoot, directory, context, requestId, version } = await fixture();
  expect(await claimUpgradeActivation(installRoot, version)).toBeUndefined();
  await writeUpgradeProgressFile(installRoot, "installer-transaction.json", {
    request_id: requestId,
    to: version,
  });
  expect(await claimUpgradeActivation(installRoot, version)).toBeUndefined();
  await writeUpgradeProgressFile(directory, "switching.json", {
    phase: "switching",
    generation: context.generation,
  });
  expect(await claimUpgradeActivation(installRoot, "1.0.0")).toBeUndefined();
  const claims = await Promise.all([
    claimUpgradeActivation(installRoot, version),
    claimUpgradeActivation(installRoot, version),
  ]);
  expect(claims.filter(Boolean)).toEqual([
    { observedUpgradeRequestId: requestId, upgradeActivationGeneration: context.generation },
  ]);
  expect(await claimUpgradeActivation(installRoot, version)).toBeUndefined();
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
