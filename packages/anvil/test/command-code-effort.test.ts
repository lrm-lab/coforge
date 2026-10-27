import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commandCodeEffortValues,
  readCommandCodeReasoningEfforts,
} from "@lrm/coforge-anvil/command-code";
import type { CommandCodeRuntimeHost } from "@lrm/coforge-anvil/command-code";
import { fixturePerTurnHost } from "./fixtures/runtime-host";

const fixtureCommand = [
  process.execPath,
  new URL("./fixtures/command-code-acp.ts", import.meta.url).pathname,
] as const;

function host(log: string, environment: Record<string, string> = {}) {
  const runtimeHost: CommandCodeRuntimeHost = {
    clientInfo: { name: "command-code-fixture", version: "1" },
    processTreeSpawner: fixturePerTurnHost.processTreeSpawner,
    versionReader: async () => "1.88.0",
    buildEnvironment: () => ({ COMMAND_CODE_FIXTURE_LOG: log, ...environment }),
    buildCatalogEnvironment: () => ({ COMMAND_CODE_FIXTURE_LOG: log, ...environment }),
    createReplyIntentScanner: () => ({
      feed: () => undefined,
      complete: () => {},
      reset: () => [],
    }),
    isShellToolName: () => false,
  };
  return runtimeHost;
}

async function records(log: string) {
  const text = (await Bun.file(log).text()).trim();
  return text
    ? text.split("\n").map(
        (line) =>
          JSON.parse(line) as {
            method?: string;
            params?: { configId?: string; value?: string };
          },
      )
    : [];
}

test("Command Code effort read drops default and keeps the current model's other values", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "anvil-command-code-effort-"));
  const log = join(cwd, "rpc.jsonl");
  try {
    expect(
      await readCommandCodeReasoningEfforts(fixtureCommand, cwd, {}, host(log), "native-model"),
    ).toEqual({ status: "ready", efforts: ["high"] });
    expect(
      await readCommandCodeReasoningEfforts(fixtureCommand, cwd, {}, host(log), "other-model"),
    ).toEqual({ status: "ready", efforts: ["low"] });
    const calls = (await records(log)).filter(
      (record) => record.method === "session/set_config_option",
    );
    expect(calls.map((record) => record.params?.value)).toEqual(["native-model", "other-model"]);
    expect((await records(log)).some((record) => record.method === "session/close")).toBe(true);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Command Code effort read treats a model without thought_level as ready and empty", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "anvil-command-code-effort-"));
  const log = join(cwd, "rpc.jsonl");
  try {
    expect(
      await readCommandCodeReasoningEfforts(fixtureCommand, cwd, {}, host(log), "plain-model"),
    ).toEqual({ status: "ready", efforts: [] });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Command Code effort read fails when the model is not listed and does not switch", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "anvil-command-code-effort-"));
  const log = join(cwd, "rpc.jsonl");
  try {
    expect(
      await readCommandCodeReasoningEfforts(fixtureCommand, cwd, {}, host(log), "missing-model"),
    ).toEqual({ status: "failed", code: "model_missing" });
    expect(
      (await records(log)).some((record) => record.method === "session/set_config_option"),
    ).toBe(false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Command Code effort read fails on timeout without waiting out a hung switch", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "anvil-command-code-effort-"));
  const log = join(cwd, "rpc.jsonl");
  const started = Date.now();
  try {
    expect(
      await readCommandCodeReasoningEfforts(
        fixtureCommand,
        cwd,
        {},
        host(log, { COMMAND_CODE_FIXTURE_HOLD_SET: "1" }),
        "native-model",
        400,
      ),
    ).toEqual({ status: "failed", code: "timeout" });
    expect(Date.now() - started).toBeLessThan(2_000);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Command Code effort values keep grouped choices and drop default, duplicates, and overlong values", () => {
  const grouped = commandCodeEffortValues([
    {
      id: "effort",
      name: "Effort",
      category: "thought_level",
      type: "select",
      currentValue: "default",
      options: [
        {
          group: "levels",
          name: "Levels",
          options: [
            { value: "default", name: "Default" },
            { value: "off", name: "Off" },
            { value: "high", name: "High" },
            { value: "high", name: "High again" },
            { value: "", name: "Empty" },
            { value: "x".repeat(65), name: "Too long" },
            { value: "max", name: "Max" },
          ],
        },
      ],
    },
  ]);
  expect(grouped).toEqual(["off", "high", "max"]);
  const many = Array.from({ length: 20 }, (_, index) => ({
    value: `level-${index}`,
    name: `Level ${index}`,
  }));
  expect(
    commandCodeEffortValues([
      {
        id: "effort",
        name: "Effort",
        category: "thought_level",
        type: "select",
        currentValue: "default",
        options: [{ value: "default", name: "Default" }, ...many],
      },
    ]),
  ).toEqual(many.slice(0, 16).map((entry) => entry.value));
});

test("Command Code effort read rejects a prototype model id before starting the CLI", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "anvil-command-code-effort-"));
  try {
    expect(
      await readCommandCodeReasoningEfforts(
        ["missing-cli"],
        cwd,
        {},
        host(join(cwd, "unused")),
        "__proto__",
      ),
    ).toEqual({ status: "failed", code: "model_missing" });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
