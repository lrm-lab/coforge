import { expect, test } from "bun:test";
import type { AgentRuntimeEvent } from "@coforge/agent";
import { ACP_TIMEOUT_MS } from "#src/grok/session";
import {
  BUDGET,
  nextCompleted,
  openFixtureSession,
  readRpcLog,
  sessionTestBudgetMs,
  SHORT_ACP_TIMEOUT_MS,
} from "./fixtures/grok-session";

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
  "a Grok interjection that races its turn end keeps its fallback turn's output and completes once",
  async () => {
    const { session, close } = await openFixtureSession();
    try {
      const events: AgentRuntimeEvent[] = [];
      session.subscribe((event) => events.push(event));
      const background = Promise.withResolvers<void>();
      const off = session.subscribe((event) => {
        if (event.type === "text-delta" && event.text === "background started")
          background.resolve();
      });
      await session.notify!("held");
      // The turn ends while Grok is queueing the interjection: Grok confirms it holds the notice
      // and then opens its own `interject-fallback-*` turn for it.
      await session.notify!("start background");
      await background.promise;
      off();
      expect(events.filter((event) => event.type === "completed")).toHaveLength(1);
      expect(session.hasLiveTurn).toBe(true);
      const done = nextCompleted(session);
      await session.notify!("finish background");
      await done;
      await Bun.sleep(25);
      expect(events.filter((event) => event.type === "completed")).toHaveLength(2);
      expect(
        events.filter(
          (event) => event.type === "text-delta" && event.text === "background started",
        ),
      ).toHaveLength(1);
      expect(session.hasLiveTurn).toBe(false);
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
        if (event.type === "compaction-started") waiting.resolve();
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
  "an interjection Grok refuses is reported undelivered instead of re-prompted",
  async () => {
    const { log, session, close } = await openFixtureSession();
    try {
      const events: AgentRuntimeEvent[] = [];
      session.subscribe((event) => events.push(event));
      await session.notify!("held");
      for (const text of ["reject", "refuse rpc"]) await session.notify!(text);
      const records = await readRpcLog(log);
      expect(
        records
          .filter((r) => r.method === "_x.ai/interject" || r.method === "session/prompt")
          .map((r) => [r.method, r.params.text ?? r.params.prompt[0].text]),
      ).toEqual([
        ["session/prompt", "held"],
        ["_x.ai/interject", "reject"],
        ["_x.ai/interject", "refuse rpc"],
      ]);
      expect(session.hasLiveTurn).toBe(true);
      // Both refusals keep their single ACK: the daemon redelivers them once the Agent is idle.
      expect(events.filter((e) => e.type === "notice-undelivered")).toEqual([
        { type: "notice-undelivered", text: "reject" },
        { type: "notice-undelivered", text: "refuse rpc" },
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
      expect(events.filter((e) => e.type === "error")).toEqual([
        {
          type: "error",
          message: "stream_error: upstream connection reset",
          providerErrorCode: "-32603",
        },
      ]);
      expect(events.at(-2)?.type).toBe("error");
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
      // The prompt was written, so its rejection is an accepted failed turn, not an unknown
      // delivery: the daemon must not resend it.
      await session.notify!("prompt error");
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
  "an ambiguous Grok admission timeout closes native input before rejecting delivery",
  async () => {
    // Production's sessions wait this long.
    expect(ACP_TIMEOUT_MS).toBe(30_000);
    const { log, session, close } = await openFixtureSession({}, SHORT_ACP_TIMEOUT_MS);
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
  sessionTestBudgetMs(SHORT_ACP_TIMEOUT_MS),
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
      const events: AgentRuntimeEvent[] = [];
      session.subscribe((event) => events.push(event));
      // Its start and end both arrived before the session was reported: it is not revived.
      expect(events).toEqual([]);
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
