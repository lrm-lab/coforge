import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandCodeEffortRead } from "@lrm/coforge-anvil/command-code";
import { CATALOG_CACHE_TTL_MS } from "#src/code-agent/runtime-inventory-cache";
import { readCommandCodeEffortsCached } from "#src/code-agent/command-code/effort-read";
import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";
import { CodeAgentInventorySync } from "#src/daemon-runtime/code-agent-inventory-sync";

const ready = (efforts: string[]): CommandCodeEffortRead => ({ status: "ready", efforts });

async function directory() {
  return mkdtemp(join(tmpdir(), "daemon-command-code-effort-"));
}

test("a Command Code effort cache hits, expires, and drops when the CLI version changes", async () => {
  const stateDirectory = await directory();
  let now = 10_000;
  let calls = 0;
  const live = async (): Promise<CommandCodeEffortRead> => {
    calls += 1;
    return ready(["off", "high"]);
  };
  const read = (version: string) =>
    readCommandCodeEffortsCached({
      modelId: "native-model",
      stateDirectory,
      version,
      now: () => now,
      live,
    });
  try {
    expect(await read("1.88.0")).toEqual(ready(["off", "high"]));
    expect(await read("1.88.0")).toEqual(ready(["off", "high"]));
    expect(calls).toBe(1);
    now += CATALOG_CACHE_TTL_MS;
    expect(await read("1.88.0")).toEqual(ready(["off", "high"]));
    expect(calls).toBe(1);
    now += 1;
    expect(await read("1.88.0")).toEqual(ready(["off", "high"]));
    expect(calls).toBe(2);
    expect(await read("1.89.0")).toEqual(ready(["off", "high"]));
    expect(calls).toBe(3);
    const stored = (await Bun.file(
      join(stateDirectory, "command-code-effort-cache.json"),
    ).json()) as {
      version: string;
    };
    expect(stored.version).toBe("1.89.0");
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("a failed Command Code effort read is not cached, and an empty list is", async () => {
  const stateDirectory = await directory();
  let calls = 0;
  const failing = async (): Promise<CommandCodeEffortRead> => {
    calls += 1;
    return { status: "failed", code: "timeout" };
  };
  try {
    const first = await readCommandCodeEffortsCached({
      modelId: "native-model",
      stateDirectory,
      version: "1.88.0",
      live: failing,
    });
    const second = await readCommandCodeEffortsCached({
      modelId: "native-model",
      stateDirectory,
      version: "1.88.0",
      live: failing,
    });
    expect(first).toEqual(second);
    expect(second).toEqual({ status: "failed", code: "timeout" });
    expect(calls).toBe(2);
    await Bun.write(
      join(stateDirectory, "command-code-effort-cache.json"),
      JSON.stringify({
        version: "1.88.0",
        entries: [
          { modelId: "plain-model", efforts: ["default", "", "high"], probedAt: Date.now() },
          { modelId: "empty-model", efforts: [], probedAt: Date.now() },
        ],
      }),
    );
    let liveCalls = 0;
    const cached = (modelId: string) =>
      readCommandCodeEffortsCached({
        modelId,
        stateDirectory,
        version: "1.88.0",
        live: async () => {
          liveCalls += 1;
          return ready(["should-not-run"]);
        },
      });
    expect(await cached("plain-model")).toEqual(ready(["high"]));
    expect(await cached("empty-model")).toEqual(ready([]));
    expect(liveCalls).toBe(0);
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("one in-flight Command Code effort read is shared, and a missing version is not", async () => {
  const stateDirectory = await directory();
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const live = () => {
    calls += 1;
    return gate.then(() => ready(["max"]));
  };
  try {
    const first = readCommandCodeEffortsCached({
      modelId: "native-model",
      stateDirectory,
      version: "1.88.0",
      live,
    });
    const second = readCommandCodeEffortsCached({
      modelId: "native-model",
      stateDirectory,
      version: "1.88.0",
      live,
    });
    expect(first).toBe(second);
    const unversioned = await Promise.all([
      readCommandCodeEffortsCached({
        modelId: "other-model",
        stateDirectory,
        version: undefined,
        live: async () => ready(["low"]),
      }),
      readCommandCodeEffortsCached({
        modelId: "other-model",
        stateDirectory,
        version: undefined,
        live: async () => ready(["low"]),
      }),
    ]);
    expect(unversioned).toEqual([ready(["low"]), ready(["low"])]);
    expect(await Bun.file(join(stateDirectory, "command-code-effort-cache.json")).exists()).toBe(
      false,
    );
    release();
    expect(await first).toEqual(ready(["max"]));
    expect(calls).toBe(1);
  } finally {
    release();
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("a cache write failure still returns the Command Code effort read", async () => {
  const stateDirectory = await directory();
  await chmod(stateDirectory, 0o555);
  try {
    expect(
      await readCommandCodeEffortsCached({
        modelId: "native-model",
        stateDirectory,
        version: "1.88.0",
        live: async () => ready(["high"]),
      }),
    ).toEqual(ready(["high"]));
    expect(
      await readCommandCodeEffortsCached({
        modelId: "   ",
        stateDirectory,
        version: "1.88.0",
        live: async () => {
          throw new Error("must not run");
        },
      }),
    ).toEqual({ status: "failed", code: "model_missing" });
  } finally {
    await chmod(stateDirectory, 0o755);
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("the effort cache keeps the newest two hundred models", async () => {
  const stateDirectory = await directory();
  let now = 1;
  try {
    for (let index = 0; index < 201; index += 1) {
      now = index + 1;
      await readCommandCodeEffortsCached({
        modelId: `model-${index}`,
        stateDirectory,
        version: "1.88.0",
        now: () => now,
        live: async () => ready(["high"]),
      });
    }
    const stored = (await Bun.file(
      join(stateDirectory, "command-code-effort-cache.json"),
    ).json()) as {
      entries: { modelId: string }[];
    };
    expect(stored.entries).toHaveLength(200);
    expect(stored.entries.some((entry) => entry.modelId === "model-0")).toBe(false);
    expect(stored.entries.some((entry) => entry.modelId === "model-200")).toBe(true);
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("an effort read without a state directory answers failed and does not start the CLI", async () => {
  const sent: unknown[] = [];
  const transport = {
    sendCommandCodeEffortReadResult: async (result: unknown) => {
      sent.push(result);
    },
  } as DaemonConnectionClient;
  const sync = new CodeAgentInventorySync(
    {
      runtimes: async () => [],
      cachedCatalogs: async () => ({ catalogs: [], needsRefresh: false }),
      catalogs: async () => ({ catalogs: [], failures: [] }),
    },
    { workspaceId: "workspace-a", computerId: "computer-a" },
    () => true,
  );
  await sync.readCommandCodeEfforts(
    {
      protocolMajor: 1,
      requestId: "effort-1",
      workspaceId: "workspace-a",
      computerId: "computer-a",
      modelId: "native-model",
    },
    transport,
  );
  expect(sent).toEqual([
    {
      protocolMajor: 1,
      requestId: "effort-1",
      workspaceId: "workspace-a",
      computerId: "computer-a",
      accepted: false,
      status: "failed",
      efforts: [],
    },
  ]);
});
