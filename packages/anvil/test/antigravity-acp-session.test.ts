import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentRuntimeEvent, AgentSession } from "@coforge/agent";
import { antigravityGeminiDirArgs } from "#src/antigravity/acp-args";
import { AntigravityAcpProvider } from "#src/antigravity/acp-provider";
import { RuntimeModelNotFoundError } from "#src/contract";
import { fixturePerTurnHost } from "./fixtures/runtime-host";

const TEST_ACP_TIMEOUT_MS = 10_000;

type Modes = readonly Record<string, string>[];

function host(
  environment: Record<string, string>,
  fed: string[] = [],
  spawnedCommands: (readonly string[])[] = [],
) {
  return {
    clientInfo: { name: "agy-acp-fixture", version: "1" },
    processTreeSpawner: {
      spawn: (command: readonly string[], cwd: string, env: Readonly<Record<string, string>>) => {
        spawnedCommands.push(command);
        return fixturePerTurnHost.processTreeSpawner.spawn(command, cwd, env);
      },
    },
    buildEnvironment: () => environment,
    versionReader: async () => "1.5.10",
    catalogCommandRunner: async () => ({ output: "{}", exitCode: 0 }),
    readUsageEnvironment: () => ({}),
    createReplyIntentScanner: () => ({
      feed: (delta: { fragment: string }) => {
        fed.push(delta.fragment);
        return undefined;
      },
      complete: () => {},
      reset: () => [],
    }),
    isShellToolName: (name: string) => name === "run_command",
  };
}

async function fixture(modes?: Modes, extraEnv: Record<string, string> = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "anvil-agy-acp-"));
  const log = join(cwd, "rpc.jsonl");
  const fed: string[] = [];
  const spawnedCommands: (readonly string[])[] = [];
  const baseCommand = [
    process.execPath,
    new URL("./fixtures/antigravity-acp.ts", import.meta.url).pathname,
  ];
  const provider = new AntigravityAcpProvider({
    acpTimeoutMs: TEST_ACP_TIMEOUT_MS,
    command: baseCommand,
    host: host(
      {
        ...extraEnv,
        AGY_ACP_FIXTURE_LOG: log,
        ...(modes ? { AGY_ACP_FIXTURE_MODES: JSON.stringify(modes) } : {}),
      },
      fed,
      spawnedCommands,
    ),
  });
  const requests = async () =>
    (await readFile(log, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  const spawnedArgs = () => spawnedCommands.map((cmd) => cmd.slice(baseCommand.length));
  return {
    provider,
    cwd,
    requests,
    fed,
    spawnedArgs,
    cleanup: () => rm(cwd, { recursive: true, force: true }),
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

const options = (cwd: string, runtime = { model: "gemini-4-carbon", reasoning: "high" }) => ({
  agentWorkspaceDirectory: cwd,
  instructions: "standing instructions",
  runtime,
});

async function withSession(
  body: (context: {
    f: Fixture;
    session: AgentSession;
    events: AgentRuntimeEvent[];
  }) => Promise<void>,
  setup: { modes?: Modes; env?: Record<string, string>; open?: (cwd: string) => object } = {},
) {
  const f = await fixture(setup.modes, setup.env);
  try {
    const session = await f.provider.createAgentSession((setup.open ?? options)(f.cwd) as never);
    const events: AgentRuntimeEvent[] = [];
    session.subscribe((event) => events.push(event));
    try {
      await body({ f, session, events });
    } finally {
      await session.dispose();
    }
  } finally {
    await f.cleanup();
  }
}

const waitFor = async (ready: () => boolean) => {
  for (let i = 0; i < 100 && !ready(); i++) await Bun.sleep(20);
  expect(ready()).toBe(true);
};

const completed = (events: AgentRuntimeEvent[]) => events.filter((e) => e.type === "completed");

const waitForRequest = async (f: Fixture, method: string) => {
  for (let i = 0; i < 100; i++) {
    if ((await f.requests()).some((r) => r.method === method)) return;
    await Bun.sleep(20);
  }
  throw new Error(`${method} never reached agy`);
};

const configCalls = async (f: Fixture) =>
  (await f.requests())
    .filter((r) => r.method === "session/set_config_option")
    .map((r) => [r.params.configId, r.params.value]);

test("a launch injects instructions and selects the auto mode", async () => {
  await withSession(async ({ f }) => {
    const requests = await f.requests();
    expect(requests.find((r) => r.method === "session/new").params._meta).toEqual({
      antigravity: { systemPrompt: { append: "standing instructions" } },
    });
    expect(requests.find((r) => r.method === "session/set_mode")?.params).toMatchObject({
      modeId: "auto",
    });
  });
});

test.each([
  [
    "the current model only sets its effort",
    "gemini-4-carbon",
    "high",
    [["thought_level", "high"]],
  ],
  [
    "thought_level follows the model just applied",
    "gemini-4-hydrogen",
    "xhigh",
    [
      ["model", "gemini-4-hydrogen"],
      ["thought_level", "xhigh"],
    ],
  ],
  [
    "a model without a thought_level select keeps its own default",
    "gpt-oss-120b-medium",
    "high",
    [["model", "gpt-oss-120b-medium"]],
  ],
  ["an effort already current sends nothing", "gemini-4-carbon", "medium", []],
])("%s", async (_name, model, reasoning, calls) => {
  await withSession(async ({ f }) => expect(await configCalls(f)).toEqual(calls), {
    open: (cwd) => options(cwd, { model, reasoning }),
  });
});

test.each([
  [
    "a model agy does not offer",
    { model: "gemini-3.1-pro-high", reasoning: "" },
    RuntimeModelNotFoundError,
  ],
  [
    "an effort the model does not offer",
    { model: "gemini-4-carbon", reasoning: "xhigh" },
    /thought_level/,
  ],
])("%s fails the launch", async (_name, runtime, failure) => {
  const f = await fixture();
  try {
    const launch = f.provider.createAgentSession(options(f.cwd, runtime) as never);
    if (failure instanceof RegExp) await expect(launch).rejects.toThrow(failure);
    else await expect(launch).rejects.toBeInstanceOf(failure);
    expect(await configCalls(f)).toEqual([]);
  } finally {
    await f.cleanup();
  }
});

test.each([
  [
    "no automatic mode",
    [
      { id: "default", name: "Default", description: "Ask before edits." },
      { id: "plan", name: "Plan", description: "Plan carefully." },
    ],
  ],
  ["a look-alike id", [{ id: "automatic", name: "Auto", description: "Approve automatically." }]],
])("a mode list with %s opens without set_mode", async (_name, modes) => {
  await withSession(
    async ({ f }) => {
      expect((await f.requests()).some((r) => r.method === "session/set_mode")).toBe(false);
    },
    { modes },
  );
});

test("a stored session agy answers -32002 for is replaced with a fresh one and reported", async () => {
  const replaced: Array<[string, string | undefined]> = [];
  await withSession(
    async () => {
      expect(replaced).toEqual([["agy-acp-fixture-session", "missing-session"]]);
    },
    {
      open: (cwd) => ({
        ...options(cwd),
        sessionId: "missing-session",
        onSessionId: async (id: string, prev: string | undefined) => {
          replaced.push([id, prev]);
        },
      }),
    },
  );
});

test("a resumed session loads with the meta envelope and opens no new session", async () => {
  await withSession(
    async ({ f }) => {
      const requests = await f.requests();
      const load = requests.find((r) => r.method === "session/load");
      expect(load?.params.sessionId).toBe("native-session-1");
      expect(load?.params._meta.antigravity.systemPrompt.append).toBe("standing instructions");
      expect(requests.some((r) => r.method === "session/new")).toBe(false);
    },
    { open: (cwd) => ({ ...options(cwd), sessionId: "native-session-1" }) },
  );
});

test("a notice during a live turn steers it instead of waiting for the turn's end", async () => {
  await withSession(async ({ f, session, events }) => {
    const first = session.sendMessage("held");
    await session.sendMessage("second");
    await first;
    const prompts = (await f.requests()).filter((r) => r.method === "session/prompt");
    expect(prompts.map((r) => r.params.prompt[0].text)).toEqual(["held", "second"]);
    expect(completed(events).length).toBeGreaterThan(0);
  });
});

test("a steered turn emits one completed and keeps its tool calls on one reader", async () => {
  await withSession(async ({ session, events }) => {
    const first = session.sendMessage("held");
    await session.sendMessage("run:ls");
    await first;
    await waitFor(() => completed(events).length > 0);
    expect(completed(events)).toHaveLength(1);
    expect(events.some((e) => e.type === "tool-start")).toBe(true);
    expect(events.some((e) => e.type === "tool-end")).toBe(true);
  });
});

test("a steer offered while an earlier steer's answer is pending still joins the turn", async () => {
  await withSession(async ({ session, events }) => {
    const first = session.sendMessage("held");
    const steerB = session.sendMessage("slow");
    await Bun.sleep(30);
    const steerC = session.sendMessage("extra");
    await Promise.all([first, steerB, steerC]);
    await waitFor(() => completed(events).length > 0);
    expect(completed(events)).toHaveLength(1);
    const text = events.flatMap((e) => (e.type === "text-delta" ? [e.text] : []));
    expect(text).toContain("slow-working");
    expect(text).toContain("extra-working");
    expect(session.hasLiveTurn).toBe(false);
  });
});

test("a refused steer reports notice-undelivered", async () => {
  await withSession(async ({ session, events }) => {
    const first = session.sendMessage("held");
    const refused = session.sendMessage("refuse");
    await first;
    await refused;
    expect(events.some((e) => e.type === "notice-undelivered")).toBe(true);
  });
});

test("an interrupt cancels the turn and keeps the same agy process for the next turn", async () => {
  await withSession(async ({ f, session, events }) => {
    const held = session.sendMessage("held").catch(() => undefined);
    await waitForRequest(f, "session/prompt");
    await session.interrupt();
    await held;
    await session.sendMessage("after");
    await waitFor(() => completed(events).length === 2);
    const methods = (await f.requests()).map((r) => r.method);
    expect(methods).toContain("session/cancel");
    expect(methods.filter((m) => m === "initialize")).toHaveLength(1);
    expect(completed(events).map((e) => e.status)).toEqual(["interrupted", "completed"]);
    expect(events.some((e) => e.type === "error")).toBe(false);
  });
});

test("EOF settles a pending steer", () =>
  withSession(async ({ session, events }) => {
    const exited = new Promise<void>((resolve) => session.onExit(() => resolve()));
    void session.sendMessage("held-silent").catch(() => {});
    await expect(session.sendMessage("crash")).rejects.toThrow("outcome is unknown");
    await exited;
    expect(completed(events)).toMatchObject([{ status: "failed" }]);
  }));

test("a relaunch after the process is gone resumes the stored session", async () => {
  const f = await fixture();
  try {
    const first = await f.provider.createAgentSession(options(f.cwd) as never);
    await first.dispose();
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

test("run_command keeps agy's name and reports its command line as command", async () => {
  await withSession(async ({ f, session, events }) => {
    await session.sendMessage("run:coforge message send --target '#general' --content hi");
    await waitFor(() => completed(events).length > 0);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool-start",
        id: "t1",
        name: "run_command",
        input: expect.objectContaining({
          command: "coforge message send --target '#general' --content hi",
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: "tool-end", id: "t1", isError: false }),
    );
    expect(f.fed.map((fragment) => JSON.parse(fragment).command)).toEqual([
      "coforge message send --target '#general' --content hi",
    ]);
  });
});

test("a file tool reports its native name and the path under file_path", async () => {
  await withSession(async ({ session, events }) => {
    await session.sendMessage("read-file");
    await waitFor(() => completed(events).length > 0);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool-start",
        id: "t2",
        name: "read_file",
        input: expect.objectContaining({ file_path: "/workspace/a.txt" }),
      }),
    );
  });
});

test("usage_update reports the context window", async () => {
  await withSession(async ({ session, events }) => {
    await session.sendMessage("hello");
    await waitFor(() => completed(events).length > 0);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "context-usage", usedTokens: 9001, windowTokens: 1048576 }),
    );
  });
});

test("a launch against agy below the ACP floor is refused without spawning the server", async () => {
  const f = await fixture();
  try {
    let spawns = 0;
    const provider = new AntigravityAcpProvider({
      command: ["/usr/bin/agy"],
      host: {
        ...host({}),
        versionReader: async () => "1.5.7",
        processTreeSpawner: {
          spawn: (...args) => {
            spawns++;
            return fixturePerTurnHost.processTreeSpawner.spawn(...args);
          },
        },
      },
    });
    await expect(provider.createAgentSession(options(f.cwd) as never)).rejects.toThrow(/1\.5\.8/);
    expect(spawns).toBe(0);
    expect(existsSync(join(f.cwd, "rpc.jsonl"))).toBe(false);
  } finally {
    await f.cleanup();
  }
});

test("permission requests for the live session are allowed between turns, while other sessions are cancelled", async () => {
  await withSession(async ({ f, session, events }) => {
    await session.sendMessage("permission-after-turn");
    await waitFor(() => completed(events).length > 0);
    let answers: Record<string, unknown> = {};
    for (let i = 0; i < 100; i++) {
      answers = Object.fromEntries(
        (await f.requests()).filter((r) => !r.method).map((r) => [r.id, r.result?.outcome]),
      );
      if ("perm-own" in answers && "perm-other" in answers) break;
      await Bun.sleep(20);
    }
    expect(answers).toEqual({
      "perm-other": { outcome: "cancelled" },
      "perm-own": { outcome: "selected", optionId: "allow" },
    });
  });
});

test("permission requests arriving while interrupting are cancelled", async () => {
  await withSession(async ({ f, session, events }) => {
    await session.sendMessage("permission-on-interrupt");
    await waitForRequest(f, "session/prompt");
    await session.interrupt!();
    await waitFor(() => completed(events).length > 0);
    const answers = Object.fromEntries(
      (await f.requests()).filter((r) => !r.method).map((r) => [r.id, r.result?.outcome]),
    );
    expect(answers).toEqual({
      "perm-interrupting": { outcome: "cancelled" },
    });
  });
});

test("a turn agy ends normally with only its in-band error line fails with that line", async () => {
  await withSession(async ({ session, events }) => {
    await session.sendMessage("inband-error");
    await waitFor(() => events.some((e) => e.type === "error"));
    expect(events.filter((e) => e.type === "error")).toEqual([
      {
        type: "error",
        message: "INVALID_ARGUMENT (code 400): Thinking level is unsupported: THINKING_LEVEL_XHIGH",
      },
    ]);
    expect(completed(events).map((e) => e.status)).toEqual(["failed"]);
  });
});

test.each(["inband-with-usage", "inband-embedded"])(
  "a turn whose text only resembles agy's error line (%s) still completes",
  async (prompt) => {
    await withSession(async ({ session, events }) => {
      await session.sendMessage(prompt);
      await waitFor(() => completed(events).length > 0);
      expect(events.some((e) => e.type === "error")).toBe(false);
      expect(completed(events).map((e) => e.status)).toEqual(["completed"]);
    });
  },
);

test("a launch spawns agy acp with --dangerously-skip-permissions and --process-per-session", async () => {
  await withSession(async ({ f }) => {
    expect(f.spawnedArgs()).toEqual([
      ["acp", "--dangerously-skip-permissions", "--process-per-session"],
    ]);
  });
});

test("a launch forwards a non-empty GEMINI_HOME as --gemini-dir and skips blank values", async () => {
  await withSession(
    async ({ f }) => {
      expect(f.spawnedArgs()).toEqual([
        [
          "acp",
          "--dangerously-skip-permissions",
          "--process-per-session",
          "--gemini-dir",
          "/tmp/custom-gemini-home",
        ],
      ]);
    },
    { env: { GEMINI_HOME: "  /tmp/custom-gemini-home  " } },
  );
  await withSession(
    async ({ f }) => {
      expect(f.spawnedArgs()).toEqual([
        ["acp", "--dangerously-skip-permissions", "--process-per-session"],
      ]);
    },
    { env: { GEMINI_HOME: "   " } },
  );
});

test("GEMINI_HOME lookup is case-insensitive on Windows and exact on POSIX", () => {
  expect(antigravityGeminiDirArgs({ gemini_home: "C:\\gemini" }, "win32")).toEqual([
    "--gemini-dir",
    "C:\\gemini",
  ]);
  expect(antigravityGeminiDirArgs({ gemini_home: "/tmp/gemini" }, "linux")).toEqual([]);
});

test("an in-band individual quota warning fails the turn with a window_limit reset", async () => {
  await withSession(async ({ session, events }) => {
    const before = Date.now();
    await session.sendMessage("inband-quota");
    await waitFor(() => completed(events).length > 0);
    const errors = events.filter((e) => e.type === "error");
    expect(errors).toHaveLength(1);
    const err = errors[0]!;
    expect(err.message).toBe(
      "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h30m.",
    );
    expect(err.providerLimit?.kind).toBe("window_limit");
    const resetMs = Date.parse(err.providerLimit?.resetsAt ?? "");
    const expectedWaitMs = (2 * 3600 + 30 * 60) * 1000;
    expect(resetMs).toBeGreaterThanOrEqual(before + expectedWaitMs - 1_000);
    expect(resetMs).toBeLessThanOrEqual(Date.now() + expectedWaitMs + 1_000);
    expect(completed(events).map((e) => e.status)).toEqual(["failed"]);
  });
});

test("a quota warning line after tool activity completes instead of misclassifying as in-band failure", async () => {
  await withSession(async ({ session, events }) => {
    await session.sendMessage("inband-quota-with-tool");
    await waitFor(() => completed(events).length > 0);
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(completed(events).map((e) => e.status)).toEqual(["completed"]);
  });
});

test("an RPC quota error attaches window_limit with the parsed resetsAt instant", async () => {
  await withSession(async ({ session, events }) => {
    const before = Date.now();
    await session.sendMessage("rpc-quota-error");
    await waitFor(() => completed(events).length > 0);
    const errors = events.filter((e) => e.type === "error");
    expect(errors).toHaveLength(1);
    const err = errors[0]!;
    expect(err.providerLimit?.kind).toBe("window_limit");
    const resetMs = Date.parse(err.providerLimit?.resetsAt ?? "");
    const expectedWaitMs = (3600 + 30 * 60 + 15) * 1000;
    expect(resetMs).toBeGreaterThanOrEqual(before + expectedWaitMs - 1_000);
    expect(resetMs).toBeLessThanOrEqual(Date.now() + expectedWaitMs + 1_000);
    expect(completed(events).map((e) => e.status)).toEqual(["failed"]);
  });
});
