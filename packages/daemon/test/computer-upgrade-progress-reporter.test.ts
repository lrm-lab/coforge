import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import {
  writeUpgradeProgressFile,
  upgradeReadyReceiptDirectory,
  upgradeReadyReceiptName,
} from "../src/platform/computer-upgrade-progress";
import { UpgradeProgressReporter } from "../src/daemon-runtime/upgrade-progress-reporter";
import { cleanupFixtures, fixture } from "./computer-upgrade-progress-fixture";

afterEach(cleanupFixtures);

test("a rejected detail write leaves the signed ready receipt available to the next process", async () => {
  const { installRoot, stateDirectory, workspaceId, requestId, context } = await fixture();
  const activation = {
    observedUpgradeRequestId: requestId,
    upgradeActivationGeneration: context.generation,
  };
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
    await before.acceptReceipt("fixture-ready-authorization", activation);
    await unavailable.promise;
    stopped.abort();
    const after = new UpgradeProgressReporter({ ...options, signal: resumed.signal });
    await after.resume([]);
    expect(await delivered.promise).toEqual({
      kind: "ready",
      receipt: "fixture-ready-authorization",
    });
    const path = join(
      upgradeReadyReceiptDirectory(stateDirectory),
      upgradeReadyReceiptName(activation),
    );
    const until = Date.now() + 1000;
    let receipt;
    do {
      receipt = (await Bun.file(path).json()) as { delivered?: boolean };
      if (!receipt.delivered) await Bun.sleep(10);
    } while (!receipt.delivered && Date.now() < until);
    expect(receipt.delivered).toBeTrue();
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
