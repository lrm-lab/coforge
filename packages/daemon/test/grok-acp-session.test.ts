import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentRuntimeEvent, AgentSession, AgentSessionOptions } from "@coforge/agent";
import { isGrokVersionUnsupported } from "#src/code-agent/grok/version";
import { GrokProvider } from "#src/code-agent/grok/provider";
import { ACP_TIMEOUT_MS } from "#src/code-agent/grok/session";
import { VERSION_PROBE_TIMEOUT_MS } from "#src/code-agent/version-gate";
import { PROCESS_TREE_EXIT_GRACE_MS } from "#src/code-agent/process-tree-cleanup";
const FIXTURE = new URL("./fixtures/grok-acp-fixture.ts", import.meta.url).pathname;
const BUDGET = VERSION_PROBE_TIMEOUT_MS + ACP_TIMEOUT_MS + 2 * PROCESS_TREE_EXIT_GRACE_MS;

/** A fixture session in its own workspace; `close` disposes it and removes the workspace. */
async function openFixtureSession(options: Partial<AgentSessionOptions> = {}) {
  const workspace = await mkdtemp(join(tmpdir(), "grok-acp-"));
  const log = join(workspace, "rpc.jsonl");
  const close = async (session?: AgentSession) => {
    await session?.dispose();
    await rm(workspace, { recursive: true, force: true });
  };
  try {
    const session = await new GrokProvider({
      command: [process.execPath, FIXTURE],
    }).createAgentSession({
      agentWorkspaceDirectory: workspace,
      instructions: "instructions",
      environment: { COFORGE_GROK_ACP_LOG: log },
      ...options,
    });
    return { log, session, close: () => close(session) };
  } catch (error) {
    await close();
    throw error;
  }
}

/** Every JSON-RPC message the fixture received from the client, in order. */
const readRpcLog = async (log: string) =>
  (await Bun.file(log).text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

/** Resolves on the session's next `completed` event. */
function nextCompleted(session: AgentSession) {
  const done = Promise.withResolvers<void>();
  const off = session.subscribe((event) => {
    if (event.type === "completed") done.resolve();
  });
  return done.promise.finally(off);
}

test(
  "Grok keeps one authenticated ACP process across protocol-completed turns",
  async () => {
    const reports: string[] = [];
    const { log, session, close } = await openFixtureSession({
      instructions: "Standing Grok instructions.",
      onSessionId: async (id) => {
        reports.push(id);
      },
    });
    try {
      expect(reports).toEqual(["0195d5a0-4b2e-7c11-9a53-3f2f6b1d7e10"]);
      const events: AgentRuntimeEvent[] = [];
      session.subscribe((event) => events.push(event));
      for (const text of ["first", "second"]) {
        const completed = nextCompleted(session);
        await session.notify!(text);
        await completed;
        expect(session.hasLiveTurn).toBe(false);
      }
      const records = await readRpcLog(log);
      expect(new Set(records.map((r) => r.pid)).size).toBe(1);
      expect(records.map((r) => r.method)).toEqual([
        "initialize",
        "authenticate",
        "session/new",
        "session/prompt",
        "session/prompt",
      ]);
      expect(records[0].argv).toContain("stdio");
      expect(records[0].argv).toContain("--no-leader");
      expect(records[0].argv).toContain("--no-auto-update");
      expect(records[0].argv).toContain("--trust");
      expect(records[2].params._meta.rules).toBe("Standing Grok instructions.");
      expect(records[2].params._meta.yoloMode).toBe(true);
      expect(records[0].argv).not.toContain("--no-background");
      expect(events.filter((e) => e.type === "completed")).toHaveLength(2);
      expect(events.filter((e) => e.type === "text-delta")).toHaveLength(2);
      expect(await session.readSessionIdentity!()).toEqual({
        sessionId: reports[0]!,
        state: "resumable",
      });
    } finally {
      await close();
    }
  },
  BUDGET,
);

test(
  "busy Grok input interjects and autonomous background turns survive the prompt response",
  async () => {
    const { log, session, close } = await openFixtureSession();
    try {
      const events: AgentRuntimeEvent[] = [];
      session.subscribe((event) => events.push(event));
      await session.notify!("held");
      expect(session.hasLiveTurn).toBe(true);
      const background = Promise.withResolvers<void>();
      const off = session.subscribe((event) => {
        if (event.type === "text-delta" && event.text === "background started")
          background.resolve();
      });
      try {
        await session.notify!("start background");
        expect(await Bun.file(log).text()).toContain("_x.ai/interject");
        await background.promise;
      } finally {
        off();
      }
      expect(session.hasLiveTurn).toBe(true);
      const done = nextCompleted(session);
      await session.notify!("finish background");
      await done;
      expect(session.hasLiveTurn).toBe(false);
      const records = await readRpcLog(log);
      expect(records.filter((r) => r.method === "session/prompt")).toHaveLength(1);
      expect(
        records.filter((r) => r.method === "_x.ai/interject").map((r) => r.params.text),
      ).toEqual(["start background", "finish background"]);
      expect(events.filter((event) => event.type === "completed")).toHaveLength(2);
    } finally {
      await close();
    }
  },
  BUDGET,
);

test(
  "Grok resumes its native session and reapplies model selection without replaying Activity",
  async () => {
    const { log, session, close } = await openFixtureSession({
      sessionId: "0195d5a0-4b2e-7c11-9a53-3f2f6b1d7e10",
      runtime: { provider: "grok", model: "grok-selected", reasoning: "high" },
    });
    try {
      expect(await session.readSessionIdentity!()).toEqual({
        sessionId: "0195d5a0-4b2e-7c11-9a53-3f2f6b1d7e10",
        state: "resumable",
      });
      expect(session.hasLiveTurn).toBe(false);
      const records = await readRpcLog(log);
      expect(records.map((r) => r.method)).toEqual([
        "initialize",
        "authenticate",
        "session/load",
        "session/set_model",
      ]);
      expect(records[2].params._meta).toEqual({ yoloMode: true });
      expect(records.at(-1).params).toMatchObject({
        modelId: "grok-selected",
        _meta: { reasoningEffort: "high" },
      });
    } finally {
      await close();
    }
  },
  BUDGET,
);

test(
  "cancelled Grok notice admission rejects both pending and queued deliveries before disposal",
  async () => {
    const { log, session, close } = await openFixtureSession();
    try {
      const waiting = Promise.withResolvers<void>();
      const off = session.subscribe((event) => {
        if (event.type === "text-delta" && event.text === "waiting for admission")
          waiting.resolve();
      });
      const first = session.notify!("hold admission");
      const second = session.notify!("must not be sent");
      const settled = Promise.allSettled([first, second]);
      await waiting.promise;
      off();
      expect(session.cancelPendingNotices).toBeFunction();
      session.cancelPendingNotices!();
      expect((await settled).map((result) => result.status)).toEqual(["rejected", "rejected"]);
      expect(await Bun.file(log).text()).not.toContain("must not be sent");
    } finally {
      await close();
    }
  },
  BUDGET,
);

test(
  "Grok reports official tool output and compaction transitions",
  async () => {
    const { session, close } = await openFixtureSession();
    try {
      const events: AgentRuntimeEvent[] = [];
      session.subscribe((event) => events.push(event));
      const done = nextCompleted(session);
      await session.notify!("display");
      await done;
      expect(events).toContainEqual({
        type: "tool-start",
        id: "tool-1",
        name: "read_file",
        input: { file_path: "notes.txt" },
      });
      expect(events).toContainEqual({ type: "tool-output", id: "tool-1", text: "display output" });
      expect(events).toContainEqual({ type: "tool-end", id: "tool-1", isError: false });
      expect(events).toContainEqual({ type: "tool-output", id: "tool-2", text: "partial output" });
      expect(events).toContainEqual({ type: "tool-end", id: "tool-2", isError: true });
      expect(events.filter((e) => e.type.startsWith("compaction-"))).toEqual([
        { type: "compaction-started" },
        { type: "compaction-interrupted" },
        { type: "compaction-started" },
        { type: "compaction-finished" },
      ]);
      expect(events).toContainEqual({
        type: "error",
        message: "compaction diagnostic",
        providerErrorReason: "auto_compact_failed",
      });
      expect(JSON.stringify(events)).not.toContain("never display raw output");
    } finally {
      await close();
    }
  },
  BUDGET,
);

test(
  "an interjection Grok refuses is delivered as a prompt and ACP cancel preserves the process",
  async () => {
    const { log, session, close } = await openFixtureSession();
    try {
      const events: AgentRuntimeEvent[] = [];
      session.subscribe((event) => events.push(event));
      await session.notify!("held");
      for (const text of ["reject", "refuse rpc"]) {
        const done = nextCompleted(session);
        await session.notify!(text);
        await done;
      }
      const records = await readRpcLog(log);
      expect(
        records
          .filter((r) => r.method === "_x.ai/interject" || r.method === "session/prompt")
          .map((r) => [r.method, r.params.text ?? r.params.prompt[0].text]),
      ).toEqual([
        ["session/prompt", "held"],
        ["_x.ai/interject", "reject"],
        ["session/prompt", "reject"],
        ["_x.ai/interject", "refuse rpc"],
        ["session/prompt", "refuse rpc"],
      ]);
      expect(session.hasLiveTurn).toBe(true);
      expect(events.filter((e) => e.type === "completed")).toEqual([
        { type: "completed", status: "completed" },
        { type: "completed", status: "completed" },
      ]);
      await session.interrupt();
      expect(session.hasLiveTurn).toBe(false);
      expect(events).toContainEqual({ type: "completed", status: "interrupted" });
      const done = nextCompleted(session);
      await session.notify!("next");
      await done;
    } finally {
      await close();
    }
  },
  BUDGET,
);

test(
  "a native Grok failure is reported before its failed turn completes",
  async () => {
    const { session, close } = await openFixtureSession();
    try {
      const events: AgentRuntimeEvent[] = [];
      session.subscribe((event) => events.push(event));
      const done = nextCompleted(session);
      await session.notify!("fail");
      await done;
      expect(events.at(-1)).toEqual({ type: "completed", status: "failed" });
      expect(events.at(-2)).toMatchObject({ type: "error", providerErrorReason: "error" });
    } finally {
      await close();
    }
  },
  BUDGET,
);

test(
  "a Grok turn that stops at its token limit completes without an error",
  async () => {
    const { session, close } = await openFixtureSession();
    try {
      const events: AgentRuntimeEvent[] = [];
      session.subscribe((event) => events.push(event));
      const done = nextCompleted(session);
      await session.notify!("max tokens");
      await done;
      expect(events.at(-1)).toEqual({ type: "completed", status: "completed" });
      expect(events.filter((e) => e.type === "error")).toEqual([]);
    } finally {
      await close();
    }
  },
  BUDGET,
);

test(
  "a rejected Grok prompt reports the native error detail",
  async () => {
    const { session, close } = await openFixtureSession();
    try {
      const events: AgentRuntimeEvent[] = [];
      session.subscribe((event) => events.push(event));
      await expect(session.notify!("prompt error")).rejects.toThrow();
      expect(events.filter((e) => e.type === "error")).toEqual([
        { type: "error", message: "model backend unavailable", providerErrorCode: "-32603" },
      ]);
      expect(events.at(-1)).toEqual({ type: "completed", status: "failed" });
    } finally {
      await close();
    }
  },
  BUDGET,
);

test(
  "a native process crash settles an autonomous Grok turn and closes the session",
  async () => {
    const { session, close } = await openFixtureSession();
    try {
      const events: AgentRuntimeEvent[] = [];
      session.subscribe((event) => events.push(event));
      const exited = Promise.withResolvers<void>();
      session.onExit(() => exited.resolve());
      await session.notify!("held");
      await session.notify!("crash background").catch(() => {});
      await exited.promise;
      expect(session.hasLiveTurn).toBe(false);
      expect(events.at(-1)).toMatchObject({ type: "completed", status: "failed" });
      expect(events.some((e) => e.type === "error")).toBe(true);
      await expect(session.notify!("late input")).rejects.toThrow();
    } finally {
      await close();
    }
  },
  BUDGET,
);

test(
  "Grok replaces only a definitively missing resumed session",
  async () => {
    const workspace = await mkdtemp(join(tmpdir(), "grok-acp-"));
    let session: AgentSession | undefined;
    const reports: unknown[] = [];
    try {
      const provider = new GrokProvider({ command: [process.execPath, FIXTURE] });
      const options = {
        agentWorkspaceDirectory: workspace,
        instructions: "instructions",
        environment: { COFORGE_GROK_ACP_LOG: join(workspace, "rpc.jsonl") },
      };
      await expect(
        provider.createAgentSession({ ...options, sessionId: "offline" }),
      ).rejects.toThrow();
      session = await provider.createAgentSession({
        ...options,
        sessionId: "missing",
        onSessionId: async (id, replaced) => {
          reports.push({ id, replaced });
        },
      });
      expect(reports).toEqual([
        { id: "0195d5a0-4b2e-7c11-9a53-3f2f6b1d7e10", replaced: "missing" },
      ]);
      expect(await session.readSessionIdentity!()).toMatchObject({ state: "empty" });
    } finally {
      await session?.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  },
  BUDGET,
);

test("Grok requires the verified persistent ACP baseline", () => {
  expect(isGrokVersionUnsupported("1.0.61")).toBe(true);
  expect(isGrokVersionUnsupported("1.0.62")).toBe(false);
  expect(isGrokVersionUnsupported("build-hash")).toBe(false);
});

test(
  "an ambiguous Grok admission timeout closes native input before rejecting delivery",
  async () => {
    const { log, session, close } = await openFixtureSession();
    try {
      const events: AgentRuntimeEvent[] = [];
      session.subscribe((event) => events.push(event));
      const pending = session.notify!("hold admission");
      const queued = session.notify!("must not be sent after timeout");
      const results = await Promise.allSettled([pending, queued]);
      expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
      expect(session.hasLiveTurn).toBe(false);
      expect(events.filter((e) => e.type === "completed")).toEqual([]);
      expect(await Bun.file(log).text()).not.toContain("must not be sent after timeout");
      await expect(session.notify!("late input")).rejects.toThrow();
    } finally {
      await close();
    }
  },
  BUDGET,
);

test(
  "a Grok interjection whose transport closes before an answer is not resent as a prompt",
  async () => {
    const { log, session, close } = await openFixtureSession();
    try {
      const exited = Promise.withResolvers<void>();
      session.onExit(() => exited.resolve());
      await session.notify!("held");
      await expect(session.notify!("exit before reply")).rejects.toThrow();
      await exited.promise;
      const records = await readRpcLog(log);
      expect(
        records.filter((r) => r.method === "session/prompt").map((r) => r.params.prompt[0].text),
      ).toEqual(["held"]);
    } finally {
      await close();
    }
  },
  BUDGET,
);

test(
  "a Grok background turn that finishes before the session is ready leaves it idle",
  async () => {
    const { log, session, close } = await openFixtureSession({
      runtime: { provider: "grok", model: "pre-ready-background", reasoning: "" },
    });
    try {
      expect(session.hasLiveTurn).toBe(false);
      const done = nextCompleted(session);
      await session.notify!("after ready");
      await done;
      const methods = (await readRpcLog(log)).map((r) => r.method);
      expect(methods).toContain("session/prompt");
      expect(methods).not.toContain("_x.ai/interject");
    } finally {
      await close();
    }
  },
  BUDGET,
);

test(
  "a streamed update for an idle Grok prompt admits it",
  async () => {
    const { session, close } = await openFixtureSession();
    try {
      const events: AgentRuntimeEvent[] = [];
      session.subscribe((event) => events.push(event));
      const started = performance.now();
      await session.notify!("stream admission");
      expect(performance.now() - started).toBeLessThan(ACP_TIMEOUT_MS / 2);
      expect(events).toContainEqual({ type: "text-delta", text: "streamed admission" });
      expect(session.hasLiveTurn).toBe(true);
    } finally {
      await close();
    }
  },
  BUDGET,
);

test(
  "Grok tool permission requests are allowed once only for the session's own turn",
  async () => {
    const { log, session, close } = await openFixtureSession();
    try {
      const done = nextCompleted(session);
      await session.notify!("permission");
      await done;
      const answers = Object.fromEntries(
        (await readRpcLog(log)).filter((r) => !r.method).map((r) => [r.id, r.result?.outcome]),
      );
      expect(answers).toEqual({
        "permission-other": { outcome: "cancelled" },
        "permission-own": { outcome: "selected", optionId: "once" },
      });
    } finally {
      await close();
    }
  },
  BUDGET,
);

test(
  "Grok resume requires native session loading",
  async () => {
    const workspace = await mkdtemp(join(tmpdir(), "grok-acp-"));
    const log = join(workspace, "rpc.jsonl");
    let session: AgentSession | undefined;
    try {
      const provider = new GrokProvider({ command: [process.execPath, FIXTURE] });
      const options = {
        agentWorkspaceDirectory: workspace,
        instructions: "instructions",
        environment: { COFORGE_GROK_ACP_LOG: log, COFORGE_GROK_MODE: "no-load-session" },
      };
      await expect(
        provider.createAgentSession({
          ...options,
          sessionId: "0195d5a0-4b2e-7c11-9a53-3f2f6b1d7e10",
        }),
      ).rejects.toThrow(/loadSession/);
      expect(await Bun.file(log).text()).not.toContain("session/load");
      session = await provider.createAgentSession(options);
      expect(await session.readSessionIdentity!()).toMatchObject({ state: "empty" });
    } finally {
      await session?.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  },
  BUDGET,
);
