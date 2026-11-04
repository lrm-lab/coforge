import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentRuntimeEvent } from "@coforge/agent";
import { AntigravityAcpProvider } from "#src/antigravity/acp-provider";
import { fixturePerTurnHost } from "./fixtures/runtime-host";

const TEST_ACP_TIMEOUT_MS = 10_000;

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "anvil-agy-acp-"));
  const log = join(cwd, "rpc.jsonl");
  const provider = new AntigravityAcpProvider({
    acpTimeoutMs: TEST_ACP_TIMEOUT_MS,
    command: [process.execPath, new URL("./fixtures/antigravity-acp.ts", import.meta.url).pathname],
    host: {
      clientInfo: { name: "agy-acp-fixture", version: "1" },
      processTreeSpawner: fixturePerTurnHost.processTreeSpawner,
      buildEnvironment: () => ({ AGY_ACP_FIXTURE_LOG: log }),
      versionReader: async () => "1.5.0",
      catalogCommandRunner: async () => ({ output: "{}", exitCode: 0 }),
      readUsageEnvironment: () => ({}),
      createReplyIntentScanner: () => ({
        feed: () => undefined,
        complete: () => {},
        reset: () => [],
      }),
      isShellToolName: () => false,
    },
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
  runtime: { model: "gemini-3.1-pro-high", reasoning: "high" },
});

test("a launch injects instructions, replays yolo, applies model and effort", async () => {
  const f = await fixture();
  try {
    const session = await f.provider.createAgentSession(options(f.cwd) as never);
    const requests = await f.requests();
    const sessionNew = requests.find((r) => r.method === "session/new");
    expect(sessionNew.params._meta).toEqual({
      antigravity: { systemPrompt: { append: "standing instructions" } },
    });
    expect(requests.find((r) => r.method === "session/set_mode")?.params).toMatchObject({
      modeId: "yolo",
    });
    const configCalls = requests.filter((r) => r.method === "session/set_config_option");
    expect(configCalls).toContainEqual(
      expect.objectContaining({
        params: expect.objectContaining({ configId: "model", value: "gemini-3.1-pro-high" }),
      }),
    );
    expect(configCalls).toContainEqual(
      expect.objectContaining({
        params: expect.objectContaining({ configId: "thinking_level", value: "high" }),
      }),
    );
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
    expect(replaced).toEqual([["agy-acp-fixture-session", "missing-session"]]);
    const requests = await f.requests();
    const load = requests.find((r) => r.method === "session/load");
    expect(load).toBeDefined();
    await session.dispose();
  } finally {
    await f.cleanup();
  }
});

test("a resumed session replays the session/load with the meta envelope", async () => {
  const f = await fixture();
  try {
    const session = await f.provider.createAgentSession({
      ...options(f.cwd),
      sessionId: "native-session-1",
    } as never);
    const requests = await f.requests();
    const load = requests.find((r) => r.method === "session/load");
    expect(load?.params.sessionId).toBe("native-session-1");
    expect(load?.params._meta.antigravity.systemPrompt.append).toBe("standing instructions");
    await session.dispose();
  } finally {
    await f.cleanup();
  }
});

test("a notice during a live turn steers it instead of waiting for the turn's end", async () => {
  const f = await fixture();
  try {
    const session = await f.provider.createAgentSession(options(f.cwd) as never);
    const events: AgentRuntimeEvent[] = [];
    session.subscribe((event) => events.push(event));
    const first = session.sendMessage("held");
    const second = session.sendMessage("second");
    await second; // admitted while "held" was still in-flight — the fixture only ends it then
    await first;
    const prompts = (await f.requests()).filter((r) => r.method === "session/prompt");
    expect(prompts.map((r) => r.params.prompt[0].text)).toEqual(["held", "second"]);
    expect(events.some((e) => e.type === "completed")).toBe(true);
    await session.dispose();
  } finally {
    await f.cleanup();
  }
});

test("a steered turn emits one completed and keeps its tool calls on one reader", async () => {
  const f = await fixture();
  try {
    const session = await f.provider.createAgentSession(options(f.cwd) as never);
    const events: AgentRuntimeEvent[] = [];
    session.subscribe((event) => events.push(event));
    const first = session.sendMessage("held");
    const second = session.sendMessage("tool-call");
    await second;
    await first;
    // The steer answer ends the merged turn: tool events from the steered prompt join the same
    // turn, and `completed` fires once when the last prompt resolves.
    await waitFor(() => events.some((e) => e.type === "completed"));
    expect(events.filter((e) => e.type === "completed")).toHaveLength(1);
    expect(events.some((e) => e.type === "tool-start")).toBe(true);
    expect(events.some((e) => e.type === "tool-end")).toBe(true);
    await session.dispose();
  } finally {
    await f.cleanup();
  }
});

test("a steer offered while an earlier steer's answer is pending still joins the turn", async () => {
  const f = await fixture();
  try {
    const session = await f.provider.createAgentSession(options(f.cwd) as never);
    const events: AgentRuntimeEvent[] = [];
    session.subscribe((event) => events.push(event));
    const first = session.sendMessage("held");
    const steerB = session.sendMessage("slow");
    // Offered after the turn's own answer arrived but before the earlier steer settles — the
    // drain must keep waiting for it rather than reporting `completed` with it in flight.
    await Bun.sleep(30);
    const steerC = session.sendMessage("extra");
    await Promise.all([first, steerB, steerC]);
    await waitFor(() => events.some((e) => e.type === "completed"));
    expect(events.filter((e) => e.type === "completed")).toHaveLength(1);
    const text = events
      .filter((e) => e.type === "text-delta")
      .map((e) => (e as { text?: string }).text);
    expect(text).toContain("slow-working");
    expect(text).toContain("extra-working");
    expect(session.hasLiveTurn).toBe(false);
    await session.dispose();
  } finally {
    await f.cleanup();
  }
});

test("a relaunch after a process kill resumes the stored session", async () => {
  const f = await fixture();
  try {
    const first = await f.provider.createAgentSession(options(f.cwd) as never);
    void first.sendMessage("held").catch(() => undefined);
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

test("a refused steer reports notice-undelivered", async () => {
  const f = await fixture();
  try {
    const session = await f.provider.createAgentSession(options(f.cwd) as never);
    const events: AgentRuntimeEvent[] = [];
    session.subscribe((event) => events.push(event));
    const first = session.sendMessage("held");
    const refused = session.sendMessage("refuse");
    await first;
    await refused;
    expect(events.some((e) => e.type === "notice-undelivered")).toBe(true);
    await session.dispose();
  } finally {
    await f.cleanup();
  }
});

test("an interrupted turn reports completed as interrupted", async () => {
  const f = await fixture();
  try {
    const session = await f.provider.createAgentSession(options(f.cwd) as never);
    const events: AgentRuntimeEvent[] = [];
    session.subscribe((event) => events.push(event));
    void session.sendMessage("held").catch(() => undefined);
    await session.interrupt();
    expect(events.filter((e) => e.type === "completed")).toEqual([
      expect.objectContaining({ status: "interrupted" }),
    ]);
    expect(events.some((e) => e.type === "error")).toBe(false);
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

test("a launch against agy below the ACP floor is refused without spawning the server", async () => {
  const f = await fixture();
  try {
    let spawns = 0;
    const provider = new AntigravityAcpProvider({
      command: ["/usr/bin/agy"],
      host: {
        clientInfo: { name: "agy-acp-fixture", version: "1" },
        processTreeSpawner: {
          spawn: (...args) => {
            spawns++;
            return fixturePerTurnHost.processTreeSpawner.spawn(...args);
          },
        },
        buildEnvironment: () => ({}),
        versionReader: async () => "1.4.9",
        catalogCommandRunner: async () => ({ output: "{}", exitCode: 0 }),
        readUsageEnvironment: () => ({}),
        createReplyIntentScanner: () => ({
          feed: () => undefined,
          complete: () => {},
          reset: () => [],
        }),
        isShellToolName: () => false,
      },
    });
    await expect(provider.createAgentSession(options(f.cwd) as never)).rejects.toThrow(
      /agy|1\.5\.0/i,
    );
    expect(spawns).toBe(0);
    expect(existsSync(join(f.cwd, "rpc.jsonl"))).toBe(false);
  } finally {
    await f.cleanup();
  }
});
