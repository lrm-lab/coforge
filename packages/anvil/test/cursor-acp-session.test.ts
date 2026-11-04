import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeEvent } from "@coforge/agent";
import { CursorAcpProvider } from "@lrm/coforge-anvil/cursor";
import { fixturePerTurnHost } from "./fixtures/runtime-host";

const FIXTURE = new URL("./fixtures/cursor-acp.ts", import.meta.url).pathname;

function testHost(logPath: string, environment: Record<string, string> = {}) {
  return {
    clientInfo: { name: "cursor-acp-fixture", version: "1" },
    processTreeSpawner: fixturePerTurnHost.processTreeSpawner,
    versionReader: async () => "2026.10.22",
    buildEnvironment: () => environment,
    createReplyIntentScanner: () => ({
      feed: () => undefined,
      complete: () => {},
      reset: () => [],
    }),
    isShellToolName: () => false,
  };
}

const options = (cwd: string) => ({
  agentWorkspaceDirectory: cwd,
  instructions: "briefing",
  sessionMode: "create" as const,
});

async function fixture(env: Record<string, string> = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "anvil-cursor-acp-"));
  const log = join(cwd, "rpc.jsonl");
  const provider = new CursorAcpProvider({
    command: [process.execPath, FIXTURE],
    host: { ...testHost(log, { CURSOR_ACP_FIXTURE_LOG: log, ...env }) },
  });
  const requests = async () => {
    try {
      return (await readFile(log, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {
      return [] as { method?: string; params?: Record<string, unknown> }[];
    }
  };
  return { provider, cwd, requests, cleanup: () => rm(cwd, { recursive: true, force: true }) };
}

const waitFor = async (ready: () => boolean) => {
  for (let i = 0; i < 100 && !ready(); i++) await Bun.sleep(20);
  expect(ready()).toBe(true);
};

/** Polls the request log asynchronously until `ready` sees the record it wants. */
const waitForRequest = async <T>(requests: () => Promise<T>, ready: (requests: T) => boolean) => {
  for (let i = 0; i < 100; i++) {
    if (ready(await requests())) return;
    await Bun.sleep(20);
  }
  expect(ready(await requests())).toBe(true);
};

test("a fresh session creates a native session and reports its id", async () => {
  const f = await fixture();
  try {
    let reported: string | undefined;
    const session = await f.provider.createAgentSession({
      ...options(f.cwd),
      onSessionId: (id: string) => {
        reported = id;
      },
    } as never);
    expect(reported).toBe("cursor-acp-fixture-session");
    const events: AgentRuntimeEvent[] = [];
    session.subscribe((event) => events.push(event));
    await session.sendMessage("hello");
    await waitFor(() => events.some((e) => e.type === "completed"));
    expect(events).toContainEqual(
      expect.objectContaining({ type: "text-delta", text: "echo hello" }),
    );
    await session.dispose();
  } finally {
    await f.cleanup();
  }
});

test("a missing stored session is replaced with a fresh one and reported", async () => {
  const f = await fixture();
  try {
    let replacedWith: string | undefined;
    let replacedFrom: string | undefined;
    const session = await f.provider.createAgentSession({
      ...options(f.cwd),
      sessionId: "missing-session",
      sessionMode: "resume",
      onSessionId: (id: string, replaced?: string) => {
        replacedWith = id;
        replacedFrom = replaced;
      },
    } as never);
    expect(replacedWith).toBe("cursor-acp-fixture-session");
    expect(replacedFrom).toBe("missing-session");
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
      sessionId: "stored-id",
      sessionMode: "resume",
    } as never);
    expect(
      (await f.requests()).some(
        (r) => r.method === "session/load" && r.params.sessionId === "stored-id",
      ),
    ).toBe(true);
    await session.dispose();
  } finally {
    await f.cleanup();
  }
});

test("a prompt during a live turn steers into it", async () => {
  const f = await fixture({ CURSOR_ACP_FIXTURE_HANG: "1" });
  try {
    const session = await f.provider.createAgentSession(options(f.cwd) as never);
    const events: AgentRuntimeEvent[] = [];
    session.subscribe((event) => events.push(event));
    void session.sendMessage("alpha");
    await waitFor(() =>
      events.some((e) => e.type === "text-delta" && (e as { text?: string }).text === "working"),
    );
    // The second prompt rides `session/prompt` too — direct steer, never a second admission. Its
    // reply arrives with the merged turn's end, so the send is not awaited here.
    void session.sendMessage("beta").catch(() => undefined);
    await waitForRequest(
      f.requests,
      (rs) => rs.filter((r) => r.method === "session/prompt").length >= 2,
    );
    await session.dispose();
  } finally {
    await f.cleanup();
  }
});

test("a relaunch after a process kill resumes the stored session and its context", async () => {
  const state = await mkdtemp(join(tmpdir(), "anvil-cursor-state-"));
  const f = await fixture({
    CURSOR_ACP_FIXTURE_HANG: "1",
    CURSOR_ACP_FIXTURE_STATE: state,
  });
  try {
    const first = await f.provider.createAgentSession(options(f.cwd) as never);
    const events: AgentRuntimeEvent[] = [];
    first.subscribe((event) => events.push(event));
    void first.sendMessage("alpha").catch(() => undefined);
    await waitFor(() =>
      events.some((e) => e.type === "text-delta" && (e as { text?: string }).text === "working"),
    );
    await first.interrupt();
    await first.dispose();
    const resumed = await f.provider.createAgentSession({
      ...options(f.cwd),
      sessionId: "cursor-acp-fixture-session",
      sessionMode: "resume",
    } as never);
    expect(
      (await f.requests()).some(
        (r) => r.method === "session/load" && r.params.sessionId === "cursor-acp-fixture-session",
      ),
    ).toBe(true);
    // The loaded process kept the stored conversation: the next prompt answers with what the
    // killed process had recorded. The fixture still hangs turns, so the recalled delta — emitted
    // before the hang — is the proof, and the session is disposed from the live turn.
    const events2: AgentRuntimeEvent[] = [];
    resumed.subscribe((event) => events2.push(event));
    void resumed.sendMessage("beta").catch(() => undefined);
    await waitFor(() =>
      events2.some(
        (e) => e.type === "text-delta" && (e as { text?: string }).text === "recalled alpha",
      ),
    );
    await resumed.dispose();
    await rm(state, { recursive: true, force: true });
  } finally {
    await f.cleanup();
  }
});

test("a launch applies the runtime model through the composite model id", async () => {
  const f = await fixture();
  try {
    const session = await f.provider.createAgentSession({
      ...options(f.cwd),
      runtime: { model: "claude-sonnet-5", reasoning: "medium" },
    } as never);
    const sets = (await f.requests()).filter((r) => r.method === "session/set_config_option");
    expect(sets).toContainEqual(
      expect.objectContaining({
        params: expect.objectContaining({
          configId: "model",
          value: "claude-sonnet-5[thinking=true,context=300k,effort=medium]",
        }),
      }),
    );
    await session.dispose();
  } finally {
    await f.cleanup();
  }
});

test("a stored model this server does not list falls back to the default and launches", async () => {
  const f = await fixture();
  const warned: string[] = [];
  try {
    const provider = new CursorAcpProvider({
      command: [process.execPath, FIXTURE],
      host: {
        ...testHost(join(f.cwd, "rpc.jsonl"), { CURSOR_ACP_FIXTURE_LOG: join(f.cwd, "rpc.jsonl") }),
        warnModelFallback: (model) => warned.push(model),
      },
    });
    const session = await provider.createAgentSession({
      ...options(f.cwd),
      runtime: { model: "claude-sonnet-4.5-thinking" },
    } as never);
    const sets = (await f.requests()).filter((r) => r.method === "session/set_config_option");
    expect(sets).toContainEqual(
      expect.objectContaining({
        params: expect.objectContaining({ configId: "model", value: "default[]" }),
      }),
    );
    expect(warned).toEqual(["claude-sonnet-4.5-thinking"]);
    await session.dispose();
  } finally {
    await f.cleanup();
  }
});

test("an unlisted name with no old-catalog effort suffix is refused", async () => {
  const f = await fixture();
  try {
    await expect(
      f.provider.createAgentSession({
        ...options(f.cwd),
        runtime: { model: "no-such-model" },
      } as never),
    ).rejects.toThrow(/model/i);
    expect((await f.requests()).every((r) => r.method !== "session/prompt")).toBe(true);
  } finally {
    await f.cleanup();
  }
});

test("the private rule file lands in .git/info/exclude when the workspace is a repo", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.cwd, ".git", "info"), { recursive: true });
    const session = await f.provider.createAgentSession(options(f.cwd) as never);
    await session.dispose();
    const exclude = await readFile(join(f.cwd, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain(".cursor/rules/coforge-agent.mdc");
  } finally {
    await f.cleanup();
  }
});

test("a workspace subdirectory inside a repo writes no exclude upstream", async () => {
  const f = await fixture();
  try {
    // The workspace lives under a repo: its `.git` sits one level up. The exclude must not be
    // written there — the rule file only hides at the workspace's own root.
    const repo = join(f.cwd, "repo");
    const ws = join(repo, "sub", "ws");
    await mkdir(join(repo, ".git", "info"), { recursive: true });
    await mkdir(ws, { recursive: true });
    const provider = new CursorAcpProvider({
      command: [process.execPath, FIXTURE],
      host: {
        ...testHost(join(ws, "rpc.jsonl"), { CURSOR_ACP_FIXTURE_LOG: join(ws, "rpc.jsonl") }),
      },
    });
    const session = await provider.createAgentSession({ ...options(ws) } as never);
    await session.dispose();
    expect(existsSync(join(repo, ".git", "info", "exclude"))).toBe(false);
  } finally {
    await f.cleanup();
  }
});

test("an exclude that does not end with a newline gets one before the pattern", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.cwd, ".git", "info"), { recursive: true });
    const exclude = join(f.cwd, ".git", "info", "exclude");
    await writeFile(exclude, "existing-rule-no-newline");
    const session = await f.provider.createAgentSession(options(f.cwd) as never);
    await session.dispose();
    const content = await readFile(exclude, "utf8");
    expect(content).toContain("existing-rule-no-newline\n.cursor/rules/coforge-agent.mdc\n");
  } finally {
    await f.cleanup();
  }
});

test("a .git file worktree writes the exclude to its commondir", async () => {
  const f = await fixture();
  try {
    // A linked worktree: `.git` is a file naming `.git/worktrees/<name>`; the shared exclude
    // lives under that dir's `commondir`.
    const common = join(f.cwd, "common");
    const gitdir = join(f.cwd, "gitdir");
    await mkdir(gitdir, { recursive: true });
    await writeFile(join(gitdir, "commondir"), common + "\n");
    await writeFile(join(f.cwd, ".git"), `gitdir: ${gitdir}\n`);
    const session = await f.provider.createAgentSession(options(f.cwd) as never);
    await session.dispose();
    const exclude = join(common, "info", "exclude");
    expect(existsSync(exclude)).toBe(true);
    expect(await readFile(exclude, "utf8")).toContain(".cursor/rules/coforge-agent.mdc");
  } finally {
    await f.cleanup();
  }
});

test("an empty reasoning means no effort, and `auto` maps to the default composite", async () => {
  const f = await fixture();
  try {
    const session = await f.provider.createAgentSession({
      ...options(f.cwd),
      runtime: { model: "auto", reasoning: "" },
    } as never);
    const sets = (await f.requests()).filter((r) => r.method === "session/set_config_option");
    expect(sets).toContainEqual(
      expect.objectContaining({
        params: expect.objectContaining({ configId: "model", value: "default[]" }),
      }),
    );
    await session.dispose();
  } finally {
    await f.cleanup();
  }
});

test("an effort no variant carries fails the launch", async () => {
  const f = await fixture();
  try {
    await expect(
      f.provider.createAgentSession({
        ...options(f.cwd),
        runtime: { model: "claude-sonnet-5", reasoning: "xhigh" },
      } as never),
    ).rejects.toThrow(/model/i);
    expect((await f.requests()).every((r) => r.method !== "session/prompt")).toBe(true);
  } finally {
    await f.cleanup();
  }
});

test("a Memory Agent session is refused with its reason before any probe or file write", async () => {
  const f = await fixture();
  try {
    const error = await f.provider
      .createAgentSession({ ...options(f.cwd), conversation: { target: "dm:@someone" } } as never)
      .then(
        () => undefined,
        (e) => e,
      );
    expect((error as { code?: string })?.code).toBe("runtime_memory_unsupported");
    // No version probe spawn and no `.cursor/rules` written.
    expect(await f.requests()).toEqual([]);
    expect(existsSync(join(f.cwd, ".cursor"))).toBe(false);
  } finally {
    await f.cleanup();
  }
});

test("an interrupt ends the turn interrupted without a session/cancel call", async () => {
  const f = await fixture({ CURSOR_ACP_FIXTURE_HANG: "1" });
  try {
    const session = await f.provider.createAgentSession(options(f.cwd) as never);
    const events: AgentRuntimeEvent[] = [];
    session.subscribe((event) => events.push(event));
    void session.sendMessage("alpha").catch(() => undefined);
    await waitFor(() =>
      events.some((e) => e.type === "text-delta" && (e as { text?: string }).text === "working"),
    );
    await session.interrupt();
    await waitFor(() => events.some((e) => e.type === "completed"));
    expect(events).toContainEqual(
      expect.objectContaining({ type: "completed", status: "interrupted" }),
    );
    expect((await f.requests()).every((r) => r.method !== "session/cancel")).toBe(true);
    await session.dispose();
  } finally {
    await f.cleanup();
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

test("standing instructions become a private .cursor/rules file that cleanup removes", async () => {
  const f = await fixture();
  try {
    const session = await f.provider.createAgentSession(options(f.cwd) as never);
    const rulePath = join(f.cwd, ".cursor", "rules", "coforge-agent.mdc");
    expect(existsSync(rulePath)).toBe(true);
    const content = await readFile(rulePath, "utf8");
    expect(content).toContain("alwaysApply: true");
    expect(content).toContain("briefing");
    await session.dispose();
    expect(existsSync(rulePath)).toBe(false);
    // The dir this launch made goes with it.
    expect(existsSync(join(f.cwd, ".cursor"))).toBe(false);
  } finally {
    await f.cleanup();
  }
});

test("a workspace's own .cursor/rules directory and files stay untouched", async () => {
  const f = await fixture();
  try {
    const rulesDir = join(f.cwd, ".cursor", "rules");
    await mkdir(rulesDir, { recursive: true });
    const own = join(rulesDir, "user-rule.mdc");
    await writeFile(own, "user rule");
    const session = await f.provider.createAgentSession(options(f.cwd) as never);
    await session.dispose();
    expect(existsSync(own)).toBe(true);
    expect(existsSync(join(rulesDir, "coforge-agent.mdc"))).toBe(false);
  } finally {
    await f.cleanup();
  }
});

test("a launch against cursor-agent below the ACP floor is refused without spawning the server", async () => {
  const f = await fixture();
  try {
    let spawns = 0;
    const provider = new CursorAcpProvider({
      command: ["/usr/bin/cursor-agent"],
      host: {
        ...testHost(join(f.cwd, "unused.jsonl")),
        versionReader: async () => "2025.01.01",
        processTreeSpawner: {
          spawn: (...args: Parameters<typeof fixturePerTurnHost.processTreeSpawner.spawn>) => {
            spawns++;
            return fixturePerTurnHost.processTreeSpawner.spawn(...args);
          },
        },
      },
    });
    await expect(provider.createAgentSession(options(f.cwd) as never)).rejects.toThrow(
      /cursor|2026\.10\.22/i,
    );
    expect(spawns).toBe(0);
  } finally {
    await f.cleanup();
  }
});
