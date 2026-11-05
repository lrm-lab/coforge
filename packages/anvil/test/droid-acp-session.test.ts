import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeEvent } from "@coforge/agent";
import { DroidAcpProvider } from "#src/droid/acp-provider";
import { fixturePerTurnHost } from "./fixtures/runtime-host";

const TEST_ACP_TIMEOUT_MS = 10_000;

const testHost = (log: string) => ({
  clientInfo: { name: "droid-acp-fixture", version: "1" },
  processTreeSpawner: fixturePerTurnHost.processTreeSpawner,
  buildEnvironment: () => ({
    DROID_ACP_FIXTURE_LOG: log,
    DROID_ACP_FIXTURE_REQUIRE_INSTRUCTIONS: "1",
  }),
  versionReader: async () => "1.4.1",
  createReplyIntentScanner: () => ({
    feed: () => undefined,
    complete: () => {},
    reset: () => [],
  }),
  isShellToolName: () => false,
});

async function fixture(environment: Record<string, string> = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "anvil-droid-acp-"));
  const log = join(cwd, "rpc.jsonl");
  const host = testHost(log);
  if (Object.keys(environment).length)
    host.buildEnvironment = () => ({ ...testHost(log).buildEnvironment(), ...environment });
  const provider = new DroidAcpProvider({
    acpTimeoutMs: TEST_ACP_TIMEOUT_MS,
    command: [process.execPath, new URL("./fixtures/droid-acp.ts", import.meta.url).pathname],
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
  runtime: { model: "claude-sonnet-5", reasoning: "max" },
});

test("a launch runs the ACP server with the instructions file and applies model and effort", async () => {
  const f = await fixture();
  try {
    const session = await f.provider.createAgentSession(options(f.cwd) as never);
    const requests = await f.requests();
    const launch = requests[0] as { argv: string[]; instructionsText: string };
    expect(launch.argv).toEqual([
      "exec",
      "--output-format",
      "acp",
      "--append-system-prompt-file",
      expect.any(String),
    ]);
    expect(launch.instructionsText).toBe("standing instructions");
    const configCalls = requests.filter((r) => r.method === "session/set_config_option");
    expect(configCalls).toContainEqual(
      expect.objectContaining({
        params: expect.objectContaining({ configId: "model", value: "claude-sonnet-5" }),
      }),
    );
    expect(configCalls).toContainEqual(
      expect.objectContaining({
        params: expect.objectContaining({ configId: "reasoning_effort", value: "max" }),
      }),
    );
    expect(requests.every((r) => r.params?._meta === undefined)).toBe(true);
    const instructionsPath = launch.argv[4]!;
    expect(existsSync(instructionsPath)).toBe(true);
    await session.dispose();
    await waitFor(() => !existsSync(instructionsPath));
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
    expect(replaced).toEqual([["droid-acp-fixture-session", "missing-session"]]);
    const requests = await f.requests();
    expect(requests.some((r) => r.method === "session/load")).toBe(true);
    expect(requests.some((r) => r.method === "session/new")).toBe(true);
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
    expect(requests.find((r) => r.method === "session/load")?.params.sessionId).toBe(
      "native-session-1",
    );
    expect(requests.every((r) => r.method !== "session/new")).toBe(true);
    await session.dispose();
  } finally {
    await f.cleanup();
  }
});

test("input queued while a turn runs is not sent to the server until the turn ends", async () => {
  const f = await fixture({ DROID_ACP_FIXTURE_HANG: "1" });
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
    // after_turn: no steer request exists on this server, so a second prompt never reaches it
    // while the first is live.
    const prompts = (await f.requests()).filter((r) => r.method === "session/prompt");
    expect(prompts.map((r) => r.params.prompt[0].text)).toEqual(["first"]);
    await session.interrupt();
    await session.dispose();
  } finally {
    await f.cleanup();
  }
});

test("an interrupted turn reports completed as interrupted and takes the process down", async () => {
  const f = await fixture({ DROID_ACP_FIXTURE_HANG: "1" });
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
    expect((await f.requests()).some((r) => r.method === "session/cancel")).toBe(false);
    await session.dispose();
  } finally {
    await f.cleanup();
  }
});

test("a process kill mid-turn keeps the stored conversation on reload", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "anvil-droid-state-"));
  const f = await fixture({
    DROID_ACP_FIXTURE_HANG: "1",
    DROID_ACP_FIXTURE_STATE: stateDirectory,
  });
  try {
    const first = await f.provider.createAgentSession(options(f.cwd) as never);
    const firstEvents: AgentRuntimeEvent[] = [];
    first.subscribe((event) => firstEvents.push(event));
    void first.sendMessage("alpha").catch(() => undefined);
    await waitFor(() =>
      firstEvents.some(
        (e) => e.type === "text-delta" && (e as { text?: string }).text === "working",
      ),
    );
    await first.interrupt();
    await first.dispose();
    const events: AgentRuntimeEvent[] = [];
    const resumed = await f.provider.createAgentSession({
      ...options(f.cwd),
      sessionId: "droid-acp-fixture-session",
    } as never);
    resumed.subscribe((event) => events.push(event));
    await resumed.sendMessage("context?");
    await waitFor(() =>
      events.some(
        (e) => e.type === "text-delta" && (e as { text?: string }).text === "recalled alpha",
      ),
    );
    await resumed.dispose();
  } finally {
    await f.cleanup();
    await rm(stateDirectory, { recursive: true, force: true });
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

test("a crash fails the turn with the process's stderr tail and removes the instructions file", async () => {
  const f = await fixture();
  try {
    const session = await f.provider.createAgentSession(options(f.cwd) as never);
    const events: AgentRuntimeEvent[] = [];
    session.subscribe((event) => events.push(event));
    const launch = (await f.requests())[0] as { argv: string[] };
    const instructionsPath = launch.argv[4]!;
    void session.sendMessage("crash").catch(() => undefined);
    await waitFor(() => events.some((e) => e.type === "completed"));
    expect(events).toContainEqual(expect.objectContaining({ type: "completed", status: "failed" }));
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "error",
        message: expect.stringContaining("fatal internal error"),
      }),
    );
    await waitFor(() => !existsSync(instructionsPath));
    await session.dispose();
  } finally {
    await f.cleanup();
  }
});

test("a launch against droid below the ACP floor is refused without spawning the server", async () => {
  const f = await fixture();
  try {
    let spawns = 0;
    const provider = new DroidAcpProvider({
      command: ["/usr/bin/droid"],
      host: {
        ...testHost(join(f.cwd, "unused.jsonl")),
        versionReader: async () => "1.4.0",
        processTreeSpawner: {
          spawn: (...args: Parameters<typeof fixturePerTurnHost.processTreeSpawner.spawn>) => {
            spawns++;
            return fixturePerTurnHost.processTreeSpawner.spawn(...args);
          },
        },
      },
    });
    await expect(provider.createAgentSession(options(f.cwd) as never)).rejects.toThrow(
      /droid|1\.4\.1/i,
    );
    expect(spawns).toBe(0);
    expect(existsSync(join(f.cwd, "rpc.jsonl"))).toBe(false);
  } finally {
    await f.cleanup();
  }
});
