import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCodeEffortValues, readOpenCodeModelEfforts } from "@lrm/coforge-anvil/opencode";
import { fixturePerTurnHost } from "./fixtures/runtime-host";

const FIXTURE = new URL("./fixtures/opencode-acp.ts", import.meta.url).pathname;

function host(environment: Record<string, string> = {}) {
  return {
    clientInfo: { name: "oc-acp-fixture", version: "1" },
    processTreeSpawner: fixturePerTurnHost.processTreeSpawner,
    versionReader: async () => "2.1.0",
    buildEnvironment: () => environment,
    createReplyIntentScanner: () => ({
      feed: () => undefined,
      complete: () => {},
      reset: () => [],
    }),
    isShellToolName: () => false,
  };
}

async function withCwd<T>(run: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), "anvil-oc-efforts-"));
  try {
    return await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test("each model's thought_level list comes back in one sweep, and the probe session is deleted", async () => {
  await withCwd(async (cwd) => {
    const log = join(cwd, "rpc.jsonl");
    const environment = {
      OPENCODE_ACP_FIXTURE_LOG: log,
      OPENCODE_ACP_FIXTURE_EFFORTS: JSON.stringify({
        "opencode/model-a": ["default", "low", "high"],
        "opencode/model-b": ["default", "max"],
      }),
    };
    const reads = await readOpenCodeModelEfforts(
      [process.execPath, FIXTURE],
      cwd,
      environment,
      host(environment),
      ["opencode/model-a", "opencode/model-b"],
      10_000,
      10_000,
    );
    expect(reads.get("opencode/model-a")).toEqual({
      status: "ready",
      efforts: ["low", "high"],
    });
    expect(reads.get("opencode/model-b")).toEqual({ status: "ready", efforts: ["max"] });
    const requests = (await readFile(log, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(requests.filter((r) => r.method === "session/set_config_option")).toHaveLength(2);
    // The probe session is deleted, not just closed: the user's history keeps nothing.
    expect(requests.some((r) => r.method === "session/delete")).toBe(true);
    expect(requests.every((r) => r.method !== "session/close")).toBe(true);
  });
});

test("a model with no effort option reports an empty list; a dead process fails the rest", async () => {
  await withCwd(async (cwd) => {
    const environment = { OPENCODE_ACP_FIXTURE_NO_EFFORTS: "1" };
    const reads = await readOpenCodeModelEfforts(
      [process.execPath, FIXTURE],
      cwd,
      environment,
      host(environment),
      ["opencode/model-a", "opencode/model-b"],
      10_000,
      10_000,
    );
    expect(reads.get("opencode/model-a")).toEqual({ status: "ready", efforts: [] });
    expect(reads.get("opencode/model-b")).toEqual({ status: "ready", efforts: [] });
  });
});

test("openCodeEffortValues drops default, dedupes, and caps values", () => {
  expect(
    openCodeEffortValues([
      {
        id: "effort",
        category: "thought_level",
        type: "select",
        currentValue: "default",
        options: [
          { value: "default", name: "Default" },
          { value: "low", name: "Low" },
          { value: "low", name: "Low again" },
          { value: "high", name: "High" },
        ],
      },
    ] as never),
  ).toEqual(["low", "high"]);
  expect(
    openCodeEffortValues([
      {
        id: "effort",
        category: "thought_level",
        type: "select",
        currentValue: "default",
        options: [{ value: "x".repeat(65), name: "Huge" }],
      },
    ] as never),
  ).toEqual([]);
  expect(openCodeEffortValues([])).toEqual([]);
  expect(openCodeEffortValues([{ id: "model", type: "text" }] as never)).toEqual([]);
});
