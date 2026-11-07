import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentRuntimeEvent } from "@coforge/agent";
import { OpenCodeAcpProvider } from "#src/opencode/acp-provider";
import { captureDaemonLogs } from "./fixtures/log-capture";
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

async function fixture(
  environment: Record<string, string> = {},
  acpTimeoutMs = TEST_ACP_TIMEOUT_MS,
  hostPatch: Record<string, unknown> = {},
) {
  const cwd = await mkdtemp(join(tmpdir(), "anvil-oc-acp-"));
  const log = join(cwd, "rpc.jsonl");
  const host = { ...testHost(log), ...hostPatch };
  if (Object.keys(environment).length)
    host.buildEnvironment = () => ({ ...testHost(log).buildEnvironment(), ...environment });
  const provider = new OpenCodeAcpProvider({
    acpTimeoutMs,
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

test("a hung session/new fails at the deadline carrying the runtime's stderr diagnostics", async () => {
  const f = await fixture(
    {
      OPENCODE_ACP_FIXTURE_HANG_SESSION_OPEN: "1",
      OPENCODE_ACP_FIXTURE_STDERR:
        'timestamp=2026-11-07T14:00:01.000Z level=ERROR run=abc message="provider bootstrap stalled"',
    },
    800,
  );
  try {
    const error = await f.provider
      .createAgentSession(options(f.cwd) as never)
      .then(() => null)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("session/new timed out");
    expect((error as Error).message).toContain("provider bootstrap stalled");
    // The hang is real: session/new was sent and never answered.
    expect((await f.requests()).some((r) => r.method === "session/new")).toBe(true);
  } finally {
    await f.cleanup();
  }
});

test("a hung session/new from a silent runtime keeps the plain timeout error", async () => {
  const f = await fixture({ OPENCODE_ACP_FIXTURE_HANG_SESSION_OPEN: "1" }, 800);
  try {
    await expect(f.provider.createAgentSession(options(f.cwd) as never)).rejects.toThrow(
      /session\/new timed out/,
    );
  } finally {
    await f.cleanup();
  }
});

test("a hung session/new carries the routine log line that names the stalled path", async () => {
  // What the cloud computer showed (task #683): stderr holds nothing but routine INFO narrative,
  // and the last line before the hang is the runtime's `watcher subscribe`. It is still the only
  // thing that says where the open is stuck, so the deadline's error has to carry it.
  const routine =
    'timestamp=2026-11-07T14:00:00.000Z level=INFO run=abc message="cli starting"\n' +
    'timestamp=2026-11-07T14:00:01.000Z level=INFO run=abc message="watcher subscribe" path=/mnt/data type=directory ignores=0';
  const f = await fixture(
    { OPENCODE_ACP_FIXTURE_HANG_SESSION_OPEN: "1", OPENCODE_ACP_FIXTURE_STDERR: routine },
    800,
  );
  try {
    const error = await f.provider
      .createAgentSession(options(f.cwd) as never)
      .then(() => null)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("session/new timed out");
    expect((error as Error).message).toContain("watcher subscribe");
    expect((error as Error).message).toContain("/mnt/data");
  } finally {
    await f.cleanup();
  }
});

test("a hung session/new keeps the newest log line when the tail outgrows the error budget", async () => {
  // The visible error is capped at 512 characters from its start. The runtime's routine narrative
  // is long, and the line that names the stalled path arrives last — so a head-first cut drops
  // exactly the line that says where the open is stuck (task #683).
  const filler = Array.from(
    { length: 4 },
    (_, index) =>
      `timestamp=2026-11-07T14:00:0${index}.000Z level=INFO run=abc message="cli starting phase ${index}" detail=${"x".repeat(120)}`,
  ).join("\n");
  const last =
    'timestamp=2026-11-07T14:00:09.000Z level=INFO run=abc message="watcher subscribe" path=/mnt/data type=directory ignores=0';
  const f = await fixture(
    {
      OPENCODE_ACP_FIXTURE_HANG_SESSION_OPEN: "1",
      OPENCODE_ACP_FIXTURE_STDERR: `${filler}\n${last}`,
    },
    800,
  );
  try {
    const error = await f.provider
      .createAgentSession(options(f.cwd) as never)
      .then(() => null)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("session/new timed out");
    expect((error as Error).message).toContain("/mnt/data");
  } finally {
    await f.cleanup();
  }
});

test("routine --print-logs stderr on a normal session end raises no warning", async () => {
  const hints: string[][] = [];
  const routine =
    'timestamp=2026-11-07T14:00:00.000Z level=INFO run=abc message="cli starting"\n' +
    'timestamp=2026-11-07T14:00:01.000Z level=INFO run=abc message="session ready"';
  const f = await fixture({ OPENCODE_ACP_FIXTURE_STDERR: routine }, TEST_ACP_TIMEOUT_MS, {
    stderrHint: (lines: readonly string[]) => hints.push([...lines]),
  });
  try {
    const { records } = await captureDaemonLogs(async () => {
      const session = await f.provider.createAgentSession(options(f.cwd) as never);
      await session.dispose();
    });
    expect(hints).toEqual([]);
    expect(records.filter((r) => r.properties.event === "code_agent.process.stderr")).toEqual([]);
  } finally {
    await f.cleanup();
  }
});

test("a diagnostic stderr line on close reaches stderrHint without the routine chatter", async () => {
  const hints: string[][] = [];
  const diagnostic =
    'timestamp=2026-11-07T14:00:01.000Z level=ERROR run=abc message="provider bootstrap exploded"';
  const f = await fixture(
    {
      OPENCODE_ACP_FIXTURE_STDERR:
        'timestamp=2026-11-07T14:00:00.000Z level=INFO run=abc message="cli starting"\n' +
        diagnostic,
    },
    TEST_ACP_TIMEOUT_MS,
    { stderrHint: (lines: readonly string[]) => hints.push([...lines]) },
  );
  try {
    const { records } = await captureDaemonLogs(async () => {
      const session = await f.provider.createAgentSession(options(f.cwd) as never);
      await session.dispose();
    });
    expect(hints).toEqual([[diagnostic]]);
    expect(
      records.filter((r) => r.properties.event === "code_agent.process.stderr").length,
    ).toBeGreaterThan(0);
  } finally {
    await f.cleanup();
  }
});
