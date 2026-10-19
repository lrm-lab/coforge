import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentRuntimeEvent, AgentSession } from "@coforge/agent";
import { isGrokVersionUnsupported } from "#src/code-agent/grok/version";
import { GrokProvider } from "#src/code-agent/grok/provider";
import { VERSION_PROBE_TIMEOUT_MS } from "#src/code-agent/version-gate";
import { PROCESS_TREE_EXIT_GRACE_MS } from "#src/code-agent/process-tree-cleanup";
const FIXTURE = new URL("./fixtures/grok-acp-fixture.ts", import.meta.url).pathname;
const BUDGET = VERSION_PROBE_TIMEOUT_MS + 30_000 + 2 * PROCESS_TREE_EXIT_GRACE_MS;

test(
  "Grok keeps one authenticated ACP process across protocol-completed turns",
  async () => {
    const workspace = await mkdtemp(join(tmpdir(), "grok-acp-"));
    const log = join(workspace, "rpc.jsonl");
    const reports: string[] = [];
    let session: AgentSession | undefined;
    try {
      session = await new GrokProvider({ command: [process.execPath, FIXTURE] }).createAgentSession(
        {
          agentWorkspaceDirectory: workspace,
          instructions: "Standing Grok instructions.",
          environment: { COFORGE_GROK_ACP_LOG: log },
          onSessionId: async (id) => {
            reports.push(id);
          },
        },
      );
      expect(reports).toEqual(["0195d5a0-4b2e-7c11-9a53-3f2f6b1d7e10"]);
      const events: AgentRuntimeEvent[] = [];
      session.subscribe((event) => events.push(event));
      for (const text of ["first", "second"]) {
        const completed = Promise.withResolvers<void>();
        const off = session.subscribe((event) => {
          if (event.type === "completed") completed.resolve();
        });
        try {
          await session.notify!(text);
          await completed.promise;
        } finally {
          off();
        }
        expect(session.hasLiveTurn).toBe(false);
      }
      const records = (await Bun.file(log).text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
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
      expect(records[0].argv).not.toContain("--no-background");
      expect(events.filter((e) => e.type === "completed")).toHaveLength(2);
      expect(events.filter((e) => e.type === "text-delta")).toHaveLength(2);
      expect(await session.readSessionIdentity!()).toEqual({
        sessionId: reports[0]!,
        state: "resumable",
      });
    } finally {
      await session?.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  },
  BUDGET,
);

test(
  "busy Grok input interjects and autonomous background turns survive the prompt response",
  async () => {
    const workspace = await mkdtemp(join(tmpdir(), "grok-acp-"));
    const log = join(workspace, "rpc.jsonl");
    let session: AgentSession | undefined;
    try {
      session = await new GrokProvider({ command: [process.execPath, FIXTURE] }).createAgentSession(
        {
          agentWorkspaceDirectory: workspace,
          instructions: "instructions",
          environment: { COFORGE_GROK_ACP_LOG: log },
        },
      );
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
      const done = Promise.withResolvers<void>();
      const offDone = session.subscribe((event) => {
        if (event.type === "completed") done.resolve();
      });
      try {
        await session.notify!("finish background");
        await done.promise;
      } finally {
        offDone();
      }
      expect(session.hasLiveTurn).toBe(false);
      const records = (await Bun.file(log).text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(records.filter((r) => r.method === "session/prompt")).toHaveLength(1);
      expect(
        records.filter((r) => r.method === "_x.ai/interject").map((r) => r.params.text),
      ).toEqual(["start background", "finish background"]);
      expect(events.filter((event) => event.type === "completed")).toHaveLength(2);
    } finally {
      await session?.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  },
  BUDGET,
);

test(
  "Grok resumes its native session and reapplies model selection without replaying Activity",
  async () => {
    const workspace = await mkdtemp(join(tmpdir(), "grok-acp-"));
    const log = join(workspace, "rpc.jsonl");
    let session: AgentSession | undefined;
    try {
      session = await new GrokProvider({ command: [process.execPath, FIXTURE] }).createAgentSession(
        {
          agentWorkspaceDirectory: workspace,
          instructions: "instructions",
          environment: { COFORGE_GROK_ACP_LOG: log },
          sessionId: "0195d5a0-4b2e-7c11-9a53-3f2f6b1d7e10",
          runtime: { provider: "grok", model: "grok-selected", reasoning: "high" },
        },
      );
      expect(await session.readSessionIdentity!()).toEqual({
        sessionId: "0195d5a0-4b2e-7c11-9a53-3f2f6b1d7e10",
        state: "resumable",
      });
      expect(session.hasLiveTurn).toBe(false);
      const records = (await Bun.file(log).text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(records.map((r) => r.method)).toEqual([
        "initialize",
        "authenticate",
        "session/load",
        "session/set_model",
      ]);
      expect(records.at(-1).params).toMatchObject({
        modelId: "grok-selected",
        _meta: { reasoningEffort: "high" },
      });
    } finally {
      await session?.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  },
  BUDGET,
);

test(
  "cancelled Grok notice admission rejects both pending and queued deliveries before disposal",
  async () => {
    const workspace = await mkdtemp(join(tmpdir(), "grok-acp-"));
    const log = join(workspace, "rpc.jsonl");
    let session: AgentSession | undefined;
    try {
      session = await new GrokProvider({ command: [process.execPath, FIXTURE] }).createAgentSession(
        {
          agentWorkspaceDirectory: workspace,
          instructions: "instructions",
          environment: { COFORGE_GROK_ACP_LOG: log },
        },
      );
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
      await session?.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  },
  BUDGET,
);

test(
  "Grok reports official tool output and compaction transitions",
  async () => {
    const workspace = await mkdtemp(join(tmpdir(), "grok-acp-"));
    let session: AgentSession | undefined;
    try {
      session = await new GrokProvider({ command: [process.execPath, FIXTURE] }).createAgentSession(
        {
          agentWorkspaceDirectory: workspace,
          instructions: "instructions",
          environment: { COFORGE_GROK_ACP_LOG: join(workspace, "rpc.jsonl") },
        },
      );
      const events: AgentRuntimeEvent[] = [];
      const done = Promise.withResolvers<void>();
      session.subscribe((event) => {
        events.push(event);
        if (event.type === "completed") done.resolve();
      });
      await session.notify!("display");
      await done.promise;
      expect(events).toContainEqual({
        type: "tool-start",
        id: "tool-1",
        name: "read_file",
        input: { file_path: "notes.txt" },
      });
      expect(events).toContainEqual({ type: "tool-output", id: "tool-1", text: "display output" });
      expect(events).toContainEqual({ type: "tool-end", id: "tool-1", isError: false });
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
      await session?.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  },
  BUDGET,
);

test(
  "failed Grok interjection does not end the live turn and ACP cancel preserves the process",
  async () => {
    const workspace = await mkdtemp(join(tmpdir(), "grok-acp-"));
    let session: AgentSession | undefined;
    try {
      session = await new GrokProvider({ command: [process.execPath, FIXTURE] }).createAgentSession(
        {
          agentWorkspaceDirectory: workspace,
          instructions: "instructions",
          environment: { COFORGE_GROK_ACP_LOG: join(workspace, "rpc.jsonl") },
        },
      );
      const events: AgentRuntimeEvent[] = [];
      session.subscribe((event) => events.push(event));
      await session.notify!("held");
      await expect(session.notify!("reject")).rejects.toThrow();
      expect(session.hasLiveTurn).toBe(true);
      expect(events.filter((e) => e.type === "completed")).toHaveLength(0);
      await session.interrupt();
      expect(session.hasLiveTurn).toBe(false);
      expect(events).toContainEqual({ type: "completed", status: "interrupted" });
      const done = Promise.withResolvers<void>();
      const off = session.subscribe((event) => {
        if (event.type === "completed") done.resolve();
      });
      try {
        await session.notify!("next");
        await done.promise;
      } finally {
        off();
      }
    } finally {
      await session?.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  },
  BUDGET,
);

test(
  "a native Grok failure is reported before its failed turn completes",
  async () => {
    const workspace = await mkdtemp(join(tmpdir(), "grok-acp-"));
    let session: AgentSession | undefined;
    try {
      session = await new GrokProvider({ command: [process.execPath, FIXTURE] }).createAgentSession(
        {
          agentWorkspaceDirectory: workspace,
          instructions: "instructions",
          environment: { COFORGE_GROK_ACP_LOG: join(workspace, "rpc.jsonl") },
        },
      );
      const events: AgentRuntimeEvent[] = [];
      const done = Promise.withResolvers<void>();
      session.subscribe((event) => {
        events.push(event);
        if (event.type === "completed") done.resolve();
      });
      await session.notify!("fail");
      await done.promise;
      expect(events.at(-1)).toEqual({ type: "completed", status: "failed" });
      expect(events.at(-2)).toMatchObject({ type: "error", providerErrorReason: "max_tokens" });
    } finally {
      await session?.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  },
  BUDGET,
);

test(
  "a native process crash settles an autonomous Grok turn and closes the session",
  async () => {
    const workspace = await mkdtemp(join(tmpdir(), "grok-acp-"));
    let session: AgentSession | undefined;
    try {
      session = await new GrokProvider({ command: [process.execPath, FIXTURE] }).createAgentSession(
        {
          agentWorkspaceDirectory: workspace,
          instructions: "instructions",
          environment: { COFORGE_GROK_ACP_LOG: join(workspace, "rpc.jsonl") },
        },
      );
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
      await session?.dispose();
      await rm(workspace, { recursive: true, force: true });
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
    const workspace = await mkdtemp(join(tmpdir(), "grok-acp-"));
    let session: AgentSession | undefined;
    try {
      session = await new GrokProvider({ command: [process.execPath, FIXTURE] }).createAgentSession(
        {
          agentWorkspaceDirectory: workspace,
          instructions: "instructions",
          environment: { COFORGE_GROK_ACP_LOG: join(workspace, "rpc.jsonl") },
        },
      );
      const events: AgentRuntimeEvent[] = [];
      session.subscribe((event) => events.push(event));
      const pending = session.notify!("hold admission");
      const queued = session.notify!("must not be sent after timeout");
      const results = await Promise.allSettled([pending, queued]);
      expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
      expect(session.hasLiveTurn).toBe(false);
      expect(events.filter((e) => e.type === "completed")).toEqual([]);
      expect(await Bun.file(join(workspace, "rpc.jsonl")).text()).not.toContain(
        "must not be sent after timeout",
      );
      await expect(session.notify!("late input")).rejects.toThrow();
    } finally {
      await session?.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  },
  BUDGET,
);
