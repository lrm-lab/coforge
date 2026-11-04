import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentRuntimeEvent } from "@coforge/agent";
import { OpenCodeAcpProvider } from "#src/opencode/acp-provider";
import { fixturePerTurnHost } from "./fixtures/runtime-host";

const TEST_ACP_TIMEOUT_MS = 10_000;

const testHost = (log: string) => ({
  clientInfo: { name: "oc-acp-fixture", version: "1" },
  processTreeSpawner: fixturePerTurnHost.processTreeSpawner,
  buildEnvironment: () => ({
    OPENCODE_ACP_FIXTURE_LOG: log,
    OPENCODE_ACP_FIXTURE_REQUIRE_CONFIG: "1",
  }),
  versionReader: async () => "2.1.0",
  createReplyIntentScanner: () => ({
    feed: () => undefined,
    complete: () => {},
    reset: () => [],
  }),
  isShellToolName: () => false,
});

async function fixture(environment: Record<string, string> = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "anvil-oc-acp-"));
  const log = join(cwd, "rpc.jsonl");
  const host = testHost(log);
  if (Object.keys(environment).length)
    host.buildEnvironment = () => ({ ...testHost(log).buildEnvironment(), ...environment });
  const provider = new OpenCodeAcpProvider({
    acpTimeoutMs: TEST_ACP_TIMEOUT_MS,
    command: [process.execPath, new URL("./fixtures/opencode-acp.ts", import.meta.url).pathname],
    host,
  });
  const requests = async () =>
    (await readFile(log, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  return { provider, cwd, requests, cleanup: () => rm(cwd, { recursive: true, force: true }) };
}

const waitFor = async (ready: () => boolean) => {
  for (let i = 0; i < 100 && !ready(); i++) await Bun.sleep(20);
  expect(ready()).toBe(true);
};

const options = (cwd: string) => ({
  agentWorkspaceDirectory: cwd,
  instructions: "standing instructions",
  runtime: { model: "opencode/model-b", reasoning: "high" },
});

test("a launch applies model and effort through the config selects", async () => {
  const f = await fixture();
  try {
    const session = await f.provider.createAgentSession(options(f.cwd) as never);
    const requests = await f.requests();
    expect(requests.some((r) => r.method === "session/new")).toBe(true);
    const configCalls = requests.filter((r) => r.method === "session/set_config_option");
    expect(configCalls).toContainEqual(
      expect.objectContaining({
        params: expect.objectContaining({ configId: "model", value: "opencode/model-b" }),
      }),
    );
    expect(configCalls).toContainEqual(
      expect.objectContaining({
        params: expect.objectContaining({ configId: "effort", value: "high" }),
      }),
    );
    // Instructions ride the process environment, never an ACP field.
    expect(requests.every((r) => r.params?._meta === undefined)).toBe(true);
    await session.dispose();
  } finally {
    await f.cleanup();
  }
});

test("a missing stored session is replaced with a fresh one and reported", async () => {
  const f = await fixture();
  try {
    const replaced: Array<[string, string | undefined]> = [];
    const session = await f.provider.createAgentSession({
      ...options(f.cwd),
      sessionId: "missing-session",
      onSessionId: async (id: string, prev: string | undefined) => {
        replaced.push([id, prev]);
      },
    } as never);
    expect(replaced).toEqual([["oc-acp-fixture-session", "missing-session"]]);
    const requests = await f.requests();
    expect(requests.find((r) => r.method === "session/load")).toBeDefined();
    expect(requests.find((r) => r.method === "session/new")).toBeDefined();
    await session.dispose();
  } finally {
    await f.cleanup();
  }
});

test("a resumed session loads the stored session id", async () => {
  const f = await fixture();
  try {
    const session = await f.provider.createAgentSession({
      ...options(f.cwd),
      sessionId: "native-session-1",
    } as never);
    const requests = await f.requests();
    const load = requests.find((r) => r.method === "session/load");
    expect(load?.params.sessionId).toBe("native-session-1");
    expect(requests.every((r) => r.method !== "session/new")).toBe(true);
    await session.dispose();
  } finally {
    await f.cleanup();
  }
});

test("input queued while a turn runs is not sent to the server until the turn ends", async () => {
  const f = await fixture({ OPENCODE_ACP_FIXTURE_HANG: "1" });
  try {
    const session = await f.provider.createAgentSession(options(f.cwd) as never);
    const events: AgentRuntimeEvent[] = [];
    session.subscribe((event) => events.push(event));
    void session.sendMessage("first").catch(() => undefined);
    await waitFor(() =>
      events.some((e) => e.type === "text-delta" && (e as { text?: string }).text === "working"),
    );
    void session.sendMessage("second").catch(() => undefined);
    await Bun.sleep(300);
    // after_turn: a second prompt never reaches the server while the first is live — opencode
    // answers an in-flight prompt with `Session already has an active ACP prompt`.
    const prompts = (await f.requests()).filter((r) => r.method === "session/prompt");
    expect(prompts.map((r) => r.params.prompt[0].text)).toEqual(["first"]);
    await session.interrupt();
    await session.dispose();
  } finally {
    await f.cleanup();
  }
});

test("a relaunch after a process kill resumes the stored session", async () => {
  const f = await fixture();
  try {
    const first = await f.provider.createAgentSession(options(f.cwd) as never);
    void first.sendMessage("go").catch(() => undefined);
    await first.interrupt();
    await first.dispose();
    // The daemon relaunches on the same id: the new process answers `session/load`, not
    // `session/new`, and the session opens.
    const resumed = await f.provider.createAgentSession({
      ...options(f.cwd),
      sessionId: "resumed-session",
    } as never);
    expect(
      (await f.requests()).some(
        (r) => r.method === "session/load" && r.params.sessionId === "resumed-session",
      ),
    ).toBe(true);
    expect(resumed.hasLiveTurn).toBe(false);
    await resumed.dispose();
  } finally {
    await f.cleanup();
  }
});

test("an interrupted turn reports completed as interrupted", async () => {
  const f = await fixture({ OPENCODE_ACP_FIXTURE_HANG: "1" });
  try {
    const session = await f.provider.createAgentSession(options(f.cwd) as never);
    const events: AgentRuntimeEvent[] = [];
    session.subscribe((event) => events.push(event));
    void session.sendMessage("go").catch(() => undefined);
    await waitFor(() =>
      events.some((e) => e.type === "text-delta" && (e as { text?: string }).text === "working"),
    );
    await session.interrupt();
    expect(events.filter((e) => e.type === "completed")).toEqual([
      expect.objectContaining({ status: "interrupted" }),
    ]);
    await session.dispose();
  } finally {
    await f.cleanup();
  }
});

test("a process kill mid-turn keeps the stored conversation on reload", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "anvil-oc-state-"));
  const f = await fixture({
    OPENCODE_ACP_FIXTURE_HANG: "1",
    OPENCODE_ACP_FIXTURE_STATE: stateDirectory,
  });
  try {
    const first = await f.provider.createAgentSession(options(f.cwd) as never);
    const firstEvents: AgentRuntimeEvent[] = [];
    first.subscribe((event) => firstEvents.push(event));
    void first.sendMessage("alpha").catch(() => undefined);
    // The hung turn's own output is the prompt's proof of record: the fixture logged it under
    // the session id before this test kills the process.
    await waitFor(() =>
      firstEvents.some(
        (e) => e.type === "text-delta" && (e as { text?: string }).text === "working",
      ),
    );
    await first.interrupt();
    await first.dispose();
    // The same id reloads: the fixture replays what the killed process recorded, the way the
    // real server restores its own turns.
    const events: AgentRuntimeEvent[] = [];
    const resumed = await f.provider.createAgentSession({
      ...options(f.cwd),
      sessionId: "oc-acp-fixture-session",
    } as never);
    resumed.subscribe((event) => events.push(event));
    await resumed.sendMessage("context?");
    await waitFor(() =>
      events.some(
        (e) => e.type === "text-delta" && (e as { text?: string }).text === "recalled alpha",
      ),
    );
    expect(
      (await f.requests()).some(
        (r) => r.method === "session/load" && r.params.sessionId === "oc-acp-fixture-session",
      ),
    ).toBe(true);
    await resumed.dispose();
  } finally {
    await f.cleanup();
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("a mid-turn crash fails the turn with the process's stderr tail", async () => {
  const f = await fixture();
  try {
    const session = await f.provider.createAgentSession(options(f.cwd) as never);
    const events: AgentRuntimeEvent[] = [];
    session.subscribe((event) => events.push(event));
    await session.sendMessage("crash").catch(() => undefined);
    await waitFor(() => events.some((e) => e.type === "completed"));
    expect(events).toContainEqual(expect.objectContaining({ type: "completed", status: "failed" }));
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "error",
        message: expect.stringContaining("fatal internal error"),
      }),
    );
    await session.dispose();
  } finally {
    await f.cleanup();
  }
});

test("a crash still removes the private instructions file", async () => {
  const f = await fixture();
  try {
    const session = await f.provider.createAgentSession(options(f.cwd) as never);
    const records = await f.requests();
    const entry = records.find((r) => r.configContent) as { configContent: string } | undefined;
    const parsed = JSON.parse(entry?.configContent ?? "") as { instructions: string[] };
    const instructionsPath = parsed.instructions[0]!;
    expect(await Bun.file(instructionsPath).exists()).toBe(true);
    void session.sendMessage("crash").catch(() => undefined);
    await waitFor(() => !existsSync(instructionsPath));
    await session.dispose();
  } finally {
    await f.cleanup();
  }
});

test("a tool call emits start and a matching end", async () => {
  const f = await fixture();
  try {
    const session = await f.provider.createAgentSession(options(f.cwd) as never);
    const events: AgentRuntimeEvent[] = [];
    session.subscribe((event) => events.push(event));
    await session.sendMessage("tool-call");
    await waitFor(() => events.some((e) => e.type === "completed"));
    expect(events).toContainEqual(expect.objectContaining({ type: "tool-start", id: "t1" }));
    expect(events).toContainEqual(
      expect.objectContaining({ type: "tool-end", id: "t1", isError: false }),
    );
    await session.dispose();
  } finally {
    await f.cleanup();
  }
});

test("a launch against opencode below the ACP floor is refused without spawning the server", async () => {
  const f = await fixture();
  try {
    let spawns = 0;
    const provider = new OpenCodeAcpProvider({
      command: ["/usr/bin/opencode"],
      host: {
        ...testHost(join(f.cwd, "unused.jsonl")),
        versionReader: async () => "2.0.30",
        processTreeSpawner: {
          spawn: (...args: Parameters<typeof fixturePerTurnHost.processTreeSpawner.spawn>) => {
            spawns++;
            return fixturePerTurnHost.processTreeSpawner.spawn(...args);
          },
        },
      },
    });
    await expect(provider.createAgentSession(options(f.cwd) as never)).rejects.toThrow(
      /opencode|2\.1\.0/i,
    );
    expect(spawns).toBe(0);
    expect(existsSync(join(f.cwd, "rpc.jsonl"))).toBe(false);
  } finally {
    await f.cleanup();
  }
});
