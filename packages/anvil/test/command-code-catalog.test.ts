import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeModelNotFoundError } from "@lrm/coforge-anvil";
import {
  discoverCommandCodeCatalog,
  CommandCodeProvider,
  type CommandCodeRuntimeHost,
} from "@lrm/coforge-anvil/command-code";
import { captureDaemonLogs } from "./fixtures/log-capture";
import { fixturePerTurnHost } from "./fixtures/runtime-host";

const fixtureCommand = [
  process.execPath,
  new URL("./fixtures/command-code-acp.ts", import.meta.url).pathname,
] as const;

function host(log: string, environment: Record<string, string> = {}) {
  let launch: readonly string[] = [];
  const runtimeHost: CommandCodeRuntimeHost = {
    clientInfo: { name: "command-code-fixture", version: "1" },
    processTreeSpawner: {
      spawn: (command, directory, env, options) => {
        launch = command;
        return fixturePerTurnHost.processTreeSpawner.spawn(command, directory, env, options);
      },
    },
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
  return { runtimeHost, launch: () => launch };
}

const models = [
  {
    id: "native-model",
    displayName: "Native",
    description: "Current default",
    modelProvider: "",
    reasoningEfforts: [],
    defaultReasoning: "",
    recommended: true,
  },
  {
    id: "other-model",
    displayName: "Other",
    description: "Shorter effort list",
    modelProvider: "",
    reasoningEfforts: [],
    defaultReasoning: "",
    recommended: false,
  },
  {
    id: "plain-model",
    displayName: "Plain",
    description: "No effort control",
    modelProvider: "",
    reasoningEfforts: [],
    defaultReasoning: "",
    recommended: false,
  },
];

async function records(log: string) {
  const text = (await Bun.file(log).text()).trim();
  return text
    ? text.split("\n").map(
        (line) =>
          JSON.parse(line) as {
            method?: string;
            params?: { sessionId?: string; configId?: string; value?: string };
          },
      )
    : [];
}

test("Command Code catalog lists session/new models and does not attach effort", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "anvil-command-code-catalog-"));
  const log = join(cwd, "rpc.jsonl");
  const fixture = host(log);
  try {
    expect(await discoverCommandCodeCatalog(fixtureCommand, cwd, {}, fixture.runtimeHost)).toEqual({
      provider: "command-code",
      models,
    });
    expect(fixture.launch()).toEqual([...fixtureCommand, "acp"]);
    expect((await records(log)).some((record) => record.method === "session/close")).toBe(true);
    expect(
      (await records(log)).some((record) => record.method === "session/set_config_option"),
    ).toBe(false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Command Code catalog reads a model list that arrives after session/new", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "anvil-command-code-catalog-"));
  const log = join(cwd, "rpc.jsonl");
  const fixture = host(log, { COMMAND_CODE_FIXTURE_DELAYED_CONFIG: "1" });
  try {
    expect(await discoverCommandCodeCatalog(fixtureCommand, cwd, {}, fixture.runtimeHost)).toEqual({
      provider: "command-code",
      models,
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Command Code catalog treats an empty model select as a finished empty list", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "anvil-command-code-catalog-"));
  const log = join(cwd, "rpc.jsonl");
  const fixture = host(log, { COMMAND_CODE_FIXTURE_EMPTY_MODEL: "1" });
  const started = Date.now();
  try {
    expect(
      await discoverCommandCodeCatalog(fixtureCommand, cwd, {}, fixture.runtimeHost, 8_000),
    ).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2_000);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Command Code catalog stops when the process exits before the model select arrives", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "anvil-command-code-catalog-"));
  const log = join(cwd, "rpc.jsonl");
  const fixture = host(log, { COMMAND_CODE_FIXTURE_EXIT_BEFORE_CONFIG: "1" });
  const started = Date.now();
  try {
    expect(
      await discoverCommandCodeCatalog(fixtureCommand, cwd, {}, fixture.runtimeHost, 8_000),
    ).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2_000);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Command Code catalog fails closed and redacts stderr when the model select never arrives", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "anvil-command-code-catalog-"));
  const log = join(cwd, "rpc.jsonl");
  const fixture = host(log, {
    COMMAND_CODE_FIXTURE_MISSING_CONFIG: "1",
    COMMAND_CODE_FIXTURE_STDERR: "1",
  });
  try {
    const { result, records: logs } = await captureDaemonLogs(async () =>
      discoverCommandCodeCatalog(fixtureCommand, cwd, {}, fixture.runtimeHost, 1_500),
    );
    expect(result).toBeUndefined();
    const failure = logs.find(
      (record) => record.properties.event === "command-code.catalog.unavailable",
    );
    expect(failure?.message.join("")).toBe("Command Code model discovery unavailable");
    expect(failure?.properties.error_message).toBe(
      "model catalog discovery failed; untrusted error detail omitted",
    );
    expect(failure?.properties.stderr_hint).toBe("auth failed [redacted]");
    expect(String(failure?.properties.stderr_hint)).not.toContain("abcdefghijklmnop");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 20_000);

async function openSession(
  cwd: string,
  environment: Record<string, string>,
  runtime?: { model: string; reasoning: string },
) {
  const log = join(cwd, "rpc.jsonl");
  let launch: readonly string[] = [];
  const fixture = host(log, environment);
  const provider = new CommandCodeProvider({
    acpTimeoutMs: 2_000,
    command: fixtureCommand,
    host: {
      ...fixture.runtimeHost,
      processTreeSpawner: {
        spawn: (command, directory, env, options) => {
          launch = command;
          return fixturePerTurnHost.processTreeSpawner.spawn(command, directory, env, options);
        },
      },
    },
  });
  const session = await provider.createAgentSession({
    agentWorkspaceDirectory: cwd,
    instructions: "briefing",
    ...(runtime ? { runtime: { provider: "command-code" as const, ...runtime } } : {}),
  });
  return {
    session,
    launch: () => launch,
    records: () => records(log),
  };
}

test("Command Code applies the selected model and an effort the returned option contains", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "anvil-command-code-model-"));
  try {
    const session = await openSession(cwd, {}, { model: "other-model", reasoning: "low" });
    try {
      const calls = (await session.records()).filter(
        (record) => record.method === "session/set_config_option",
      );
      expect(calls.map((record) => record.params)).toEqual([
        { sessionId: "command-code-fixture-session", configId: "model", value: "other-model" },
        { sessionId: "command-code-fixture-session", configId: "effort", value: "low" },
      ]);
      expect(session.launch()).toContain("--mod");
    } finally {
      await session.session.dispose();
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Command Code leaves the model default when that model has no effort option", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "anvil-command-code-model-"));
  try {
    const session = await openSession(cwd, {}, { model: "plain-model", reasoning: "high" });
    try {
      const calls = (await session.records()).filter(
        (record) => record.method === "session/set_config_option",
      );
      expect(calls.map((record) => record.params)).toEqual([
        { sessionId: "command-code-fixture-session", configId: "model", value: "plain-model" },
      ]);
    } finally {
      await session.session.dispose();
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Command Code reports a model the CLI does not offer as model_not_found", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "anvil-command-code-model-"));
  const log = join(cwd, "rpc.jsonl");
  try {
    const error = await openSession(cwd, {}, { model: "missing-model", reasoning: "" }).then(
      () => {
        throw new Error("missing model was accepted");
      },
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(RuntimeModelNotFoundError);
    expect(error).toMatchObject({ code: "model_not_found", model: "missing-model" });
    expect(await Bun.file(log).text()).not.toContain("session/set_config_option");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Command Code fails the session when the returned effort option lacks the configured value", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "anvil-command-code-model-"));
  try {
    await expect(openSession(cwd, {}, { model: "other-model", reasoning: "high" })).rejects.toThrow(
      "Command Code effort selection is unavailable",
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
