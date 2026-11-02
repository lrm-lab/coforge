import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentRuntimeEvent, AgentSession } from "@coforge/agent";
import { isGrokVersionUnsupported } from "#src/grok/version";
import { grokProvider } from "./fixtures/grok-host";
import {
  BUDGET,
  FIXTURE,
  nextCompleted,
  openFixtureSession,
  readRpcLog,
} from "./fixtures/grok-session";

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
      expect(records[0].argv.filter((arg: string) => arg.startsWith("--"))).toEqual([
        "--trust",
        "--no-leader",
        "--always-approve",
      ]);
      // The standing instructions replace Grok's native system prompt; `rules` would append them.
      expect(records[2].params._meta.systemPromptOverride).toBe("Standing Grok instructions.");
      expect(records[2].params._meta).not.toHaveProperty("rules");
      expect(records[2].params._meta.yoloMode).toBe(true);
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
  "Grok resumes its native session with current instructions and model selection, without replaying Activity",
  async () => {
    const { log, session, close } = await openFixtureSession({
      sessionId: "0195d5a0-4b2e-7c11-9a53-3f2f6b1d7e10",
      instructions: "Updated standing instructions.",
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
      expect(records[2].params._meta).toEqual({
        yoloMode: true,
        systemPromptOverride: "Updated standing instructions.",
      });
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
  "blank Grok instructions leave the native system prompt in place on new and load",
  async () => {
    for (const sessionId of [undefined, "0195d5a0-4b2e-7c11-9a53-3f2f6b1d7e10"]) {
      const { log, close } = await openFixtureSession({ instructions: "  ", sessionId });
      try {
        const opened = (await readRpcLog(log)).find(
          (r) => r.method === (sessionId ? "session/load" : "session/new"),
        );
        // Grok ignores a blank override, so neither key is sent.
        expect(opened.params._meta).toEqual({ yoloMode: true });
      } finally {
        await close();
      }
    }
  },
  2 * BUDGET,
);

test(
  "Grok replaces only a definitively missing resumed session",
  async () => {
    const workspace = await mkdtemp(join(tmpdir(), "grok-acp-"));
    let session: AgentSession | undefined;
    const reports: unknown[] = [];
    try {
      const provider = grokProvider({ command: [process.execPath, FIXTURE] });
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
      const provider = grokProvider({ command: [process.execPath, FIXTURE] });
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
