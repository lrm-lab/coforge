import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeEvent } from "@lrm/coforge-anvil";
import { isOpenCodeVersionUnsupported } from "@lrm/coforge-anvil/opencode";
import { OPENCODE_MEMORY_IDENTITY_PROMPT } from "../src/opencode/turn-protocol";
import {
  OPENCODE_INSTRUCTIONS,
  firstProgress,
  nthCompleted,
  nthTurn,
  openCodeProvider,
  readLaunches,
} from "./fixtures/opencode-session-harness";

test("a turn starts even though the CLI waits for stdin EOF before it emits anything", async () => {
  // s144, 2026-09-22: `opencode run` waits for stdin EOF. An open pipe never starts the turn.
  const directory = await mkdtemp(join(tmpdir(), "opencode-stdin-eof-"));
  try {
    const session = await openCodeProvider().createAgentSession({
      agentWorkspaceDirectory: directory,
      instructions: OPENCODE_INSTRUCTIONS,
      environment: { COFORGE_OPENCODE_MODE: "text", COFORGE_OPENCODE_REQUIRE_STDIN_EOF: "1" },
    });
    try {
      const completed = nthCompleted(session, 1);
      await session.sendMessage("ping");
      await completed;
      expect((await session.readSessionIdentity!())?.state).toBe("resumable");
    } finally {
      await session.dispose();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);

test("a fresh session sends the user prompt and no instructions turn", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-fresh-"));
  const log = join(directory, "launches.jsonl");
  try {
    const session = await openCodeProvider().createAgentSession({
      agentWorkspaceDirectory: directory,
      instructions: OPENCODE_INSTRUCTIONS,
      environment: { COFORGE_OPENCODE_MODE: "text", COFORGE_OPENCODE_LAUNCH_LOG: log },
    });
    try {
      expect(await readLaunches(log)).toHaveLength(0);
      await nthTurn(session, "do the thing");
      const launches = await readLaunches(log);
      expect(launches).toHaveLength(1);
      expect(launches[0]?.prompt).toBe("do the thing");
      expect(launches[0]?.resumeId).toBeUndefined();
      expect((await session.readSessionIdentity!())?.state).toBe("resumable");
    } finally {
      await session.dispose();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a fresh memory control session names its id before any user turn", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-memory-id-"));
  const log = join(directory, "launches.jsonl");
  try {
    const session = await openCodeProvider().createAgentSession({
      agentWorkspaceDirectory: directory,
      instructions: OPENCODE_INSTRUCTIONS,
      memoryControlSession: true,
      environment: { COFORGE_OPENCODE_MODE: "text", COFORGE_OPENCODE_LAUNCH_LOG: log },
    });
    try {
      const identity = await session.readSessionIdentity!();
      expect(identity?.sessionId).toBeString();
      expect(identity?.sessionId.length).toBeGreaterThan(0);
      const launches = await readLaunches(log);
      expect(launches).toHaveLength(1);
      expect(launches[0]?.prompt).toBe(OPENCODE_MEMORY_IDENTITY_PROMPT);
      expect(launches[0]?.resumeId).toBeUndefined();
    } finally {
      await session.dispose();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a resumed memory control session waits for real input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-memory-resume-"));
  const log = join(directory, "launches.jsonl");
  try {
    const session = await openCodeProvider().createAgentSession({
      agentWorkspaceDirectory: directory,
      instructions: OPENCODE_INSTRUCTIONS,
      memoryControlSession: true,
      sessionId: "session-existing",
      environment: { COFORGE_OPENCODE_MODE: "text", COFORGE_OPENCODE_LAUNCH_LOG: log },
    });
    try {
      expect(await readLaunches(log)).toHaveLength(0);
      expect(await session.readSessionIdentity!()).toEqual({
        sessionId: "session-existing",
        state: "resumable",
      });
    } finally {
      await session.dispose();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a later message resumes the session id OpenCode reported, with model and variant", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-resume-"));
  const log = join(directory, "launches.jsonl");
  try {
    const session = await openCodeProvider().createAgentSession({
      agentWorkspaceDirectory: directory,
      instructions: OPENCODE_INSTRUCTIONS,
      runtime: {
        provider: "opencode",
        model: "opencode/big-pickle",
        reasoning: "high",
        modelProvider: "opencode",
      },
      environment: {
        COFORGE_OPENCODE_MODE: "text",
        COFORGE_OPENCODE_SESSION_ID: "session-abc",
        COFORGE_OPENCODE_TURN_DELAY_MS: "120",
        COFORGE_OPENCODE_LAUNCH_LOG: log,
      },
    });
    try {
      await nthTurn(session, "hello");
      await nthTurn(session, "do the thing");
      const launches = await readLaunches(log);
      expect(launches).toHaveLength(2);
      expect(launches[0]?.resumeId).toBeUndefined();
      expect(launches[1]).toMatchObject({
        prompt: "do the thing",
        model: "opencode/big-pickle",
        variant: "high",
        resumeId: "session-abc",
      });
    } finally {
      await session.dispose();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a resumed session spawns nothing until real input arrives", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-resumed-"));
  const log = join(directory, "launches.jsonl");
  try {
    const session = await openCodeProvider().createAgentSession({
      agentWorkspaceDirectory: directory,
      instructions: OPENCODE_INSTRUCTIONS,
      sessionId: "session-existing",
      environment: { COFORGE_OPENCODE_MODE: "text", COFORGE_OPENCODE_LAUNCH_LOG: log },
    });
    try {
      expect(await readLaunches(log)).toHaveLength(0);
      const completed = nthCompleted(session, 1);
      await session.sendMessage("wake up");
      await completed;
      expect((await readLaunches(log))[0]).toMatchObject({
        prompt: "wake up",
        resumeId: "session-existing",
      });
    } finally {
      await session.dispose();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("maps OpenCode's text and tool events onto the runtime contract", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-tool-"));
  try {
    const session = await openCodeProvider().createAgentSession({
      agentWorkspaceDirectory: directory,
      instructions: OPENCODE_INSTRUCTIONS,
      environment: { COFORGE_OPENCODE_MODE: "tool", COFORGE_OPENCODE_TURN_DELAY_MS: "120" },
    });
    try {
      const events: AgentRuntimeEvent[] = [];
      const completed = new Promise<void>((resolve) => {
        session.subscribe((event) => {
          events.push(event);
          if (event.type === "completed") resolve();
        });
      });
      await session.sendMessage("go");
      await completed;
      expect(events.filter((event) => event.type === "tool-start")).toEqual([
        {
          type: "tool-start",
          id: "call-1",
          name: "bash",
          input: { command: "echo hi" },
          occurredAt: expect.any(String),
        },
      ]);
      expect(events).toContainEqual({ type: "tool-output", id: "call-1", text: "hi" });
      expect(events).toContainEqual({ type: "tool-end", id: "call-1", isError: false });
      expect(events).toContainEqual({ type: "text-delta", text: "done" });
    } finally {
      await session.dispose();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an error event fails the turn with OpenCode's own message", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-error-"));
  try {
    const session = await openCodeProvider().createAgentSession({
      agentWorkspaceDirectory: directory,
      instructions: OPENCODE_INSTRUCTIONS,
      environment: { COFORGE_OPENCODE_MODE: "error-event", COFORGE_OPENCODE_TURN_DELAY_MS: "120" },
    });
    try {
      const events: AgentRuntimeEvent[] = [];
      const completed = new Promise<void>((resolve) => {
        session.subscribe((event) => {
          events.push(event);
          if (event.type === "completed") resolve();
        });
      });
      await session.sendMessage("go");
      await completed;
      expect(events).toContainEqual({
        type: "error",
        message: "no credentials for provider opencode",
      });
      expect(events).toContainEqual({ type: "completed", status: "failed" });
    } finally {
      await session.dispose();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a provider quota failure surfaces its kind, status and message, not a bare label", async () => {
  // 2026-09-23: a quota envelope was collapsed into "Agent runtime failed."
  const directory = await mkdtemp(join(tmpdir(), "opencode-quota-"));
  try {
    const session = await openCodeProvider().createAgentSession({
      agentWorkspaceDirectory: directory,
      instructions: OPENCODE_INSTRUCTIONS,
      environment: {
        COFORGE_OPENCODE_MODE: "provider-quota",
        COFORGE_OPENCODE_TURN_DELAY_MS: "120",
      },
    });
    try {
      const events: AgentRuntimeEvent[] = [];
      const completed = new Promise<void>((resolve) => {
        session.subscribe((event) => {
          events.push(event);
          if (event.type === "completed") resolve();
        });
      });
      await session.sendMessage("go");
      await completed;
      expect(events).toContainEqual({
        type: "error",
        message: "provider.quota (HTTP 429): Rate limit exceeded. Please try again later.",
      });
      expect(events).toContainEqual({ type: "completed", status: "failed" });
    } finally {
      await session.dispose();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an unfamiliar error envelope still fails the turn with a non-empty message", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-opaque-"));
  try {
    const session = await openCodeProvider().createAgentSession({
      agentWorkspaceDirectory: directory,
      instructions: OPENCODE_INSTRUCTIONS,
      environment: { COFORGE_OPENCODE_MODE: "opaque-error", COFORGE_OPENCODE_TURN_DELAY_MS: "120" },
    });
    try {
      const events: AgentRuntimeEvent[] = [];
      const completed = new Promise<void>((resolve) => {
        session.subscribe((event) => {
          events.push(event);
          if (event.type === "completed") resolve();
        });
      });
      await session.sendMessage("go");
      await completed;
      const error = events.find((event) => event.type === "error");
      expect(error && error.type === "error" ? error.message.trim() : "").not.toBe("");
      expect(events).toContainEqual({ type: "completed", status: "failed" });
    } finally {
      await session.dispose();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a non-zero exit fails the turn with its exit code and stderr tail", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-crash-"));
  try {
    const session = await openCodeProvider().createAgentSession({
      agentWorkspaceDirectory: directory,
      instructions: OPENCODE_INSTRUCTIONS,
      environment: { COFORGE_OPENCODE_MODE: "crash" },
    });
    try {
      const events: AgentRuntimeEvent[] = [];
      const completed = new Promise<void>((resolve) => {
        session.subscribe((event) => {
          events.push(event);
          if (event.type === "completed") resolve();
        });
      });
      await session.sendMessage("go");
      await completed;
      const error = events.find((event) => event.type === "error");
      expect(error).toMatchObject({ type: "error" });
      expect(error && error.type === "error" ? error.message : "").toContain(
        "exit code 1 | stderr: Error: model not found: opencode/nope",
      );
      expect(events).toContainEqual({ type: "completed", status: "failed" });
    } finally {
      await session.dispose();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("interrupting a running turn ends it as interrupted", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-interrupt-"));
  try {
    const session = await openCodeProvider().createAgentSession({
      agentWorkspaceDirectory: directory,
      instructions: OPENCODE_INSTRUCTIONS,
      environment: { COFORGE_OPENCODE_MODE: "hang" },
    });
    try {
      const running = firstProgress(session);
      const completed = new Promise<void>((resolve) => {
        session.subscribe((event) => {
          if (event.type === "completed") resolve();
        });
      });
      await session.sendMessage("go");
      await running;
      await session.interrupt();
      await completed;
    } finally {
      await session.dispose();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("gates the CLI on OpenCode 2.0.30, when configured instructions first load", () => {
  expect(isOpenCodeVersionUnsupported("1.18.31")).toBe(true);
  expect(isOpenCodeVersionUnsupported("2.0.0")).toBe(true);
  expect(isOpenCodeVersionUnsupported("2.0.7")).toBe(true);
  expect(isOpenCodeVersionUnsupported("2.0.29")).toBe(true);
  expect(isOpenCodeVersionUnsupported("2.0.30")).toBe(false);
  expect(isOpenCodeVersionUnsupported("2.1.0")).toBe(false);
  // A version we cannot parse confidently is never gated.
  expect(isOpenCodeVersionUnsupported("nightly")).toBe(false);
});
