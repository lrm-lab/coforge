import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createSession, findSessionFile } from "../src/runner";
import { rotatePiSessionTranscriptIfOversized } from "../src/session-rotation";

let workspaceDir: string;
let sessionDir: string;

beforeEach(async () => {
  workspaceDir = await realpath(await mkdtemp(join(tmpdir(), "coforge-pi-rotate-")));
  sessionDir = join(workspaceDir, ".pi-sessions");
});

afterEach(async () => {
  await rm(workspaceDir, { recursive: true, force: true });
});

function userMsg(text: string) {
  return {
    role: "user" as const,
    content: [{ type: "text" as const, text }],
    timestamp: Date.now(),
  };
}

function assistantMsg(text: string) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "anthropic-messages" as const,
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    usage: {
      input: 100,
      output: 50,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 150,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };
}

test("rotatePiSessionTranscriptIfOversized leaves transcripts under maxBytes untouched", async () => {
  const manager = SessionManager.create(workspaceDir, sessionDir, { id: "session-small" });
  manager.appendMessage(userMsg("hello"));
  manager.appendMessage(assistantMsg("hi"));
  const result = await rotatePiSessionTranscriptIfOversized(manager, { maxBytes: 1024 * 1024 });
  expect(result.rotated).toBe(false);
});

test("rotatePiSessionTranscriptIfOversized prunes pre-compaction bloat atomically while preserving active context and single session file", async () => {
  const manager = SessionManager.create(workspaceDir, sessionDir, { id: "session-compacted" });
  manager.appendModelChange("anthropic", "claude-sonnet-4-5");
  manager.appendThinkingLevelChange("high");

  // Append large pre-compaction turns that compaction summarizes away.
  for (let i = 0; i < 12; i++) {
    manager.appendMessage(userMsg(`old turn ${i}: ${"X".repeat(8_000)}`));
    manager.appendMessage(assistantMsg(`old reply ${i}: ${"Y".repeat(8_000)}`));
  }
  const keptUserId = manager.appendMessage(userMsg("kept turn before compaction"));
  manager.appendMessage(assistantMsg("kept assistant reply"));
  manager.appendCompaction("Summary of turns 0..11", keptUserId, 260_000);
  manager.appendMessage(userMsg("turn after compaction"));
  manager.appendMessage(assistantMsg("fresh reply after compaction"));

  const sessionFile = manager.getSessionFile()!;
  const beforeBytes = (await stat(sessionFile)).size;
  expect(beforeBytes).toBeGreaterThan(150_000);
  const contextBefore = manager.buildSessionContext();

  const rotated = await rotatePiSessionTranscriptIfOversized(manager, { maxBytes: 32_000 });
  expect(rotated.rotated).toBe(true);
  expect(rotated.afterBytes).toBeLessThan(20_000);

  // Only one .jsonl file and zero .tmp files exist, so findSessionFile succeeds unambiguously.
  const entriesOnDisk = await readdir(sessionDir);
  expect(entriesOnDisk.filter((name) => name.endsWith(".jsonl"))).toHaveLength(1);
  expect(entriesOnDisk.filter((name) => name.endsWith(".tmp"))).toHaveLength(0);
  expect(await findSessionFile(sessionDir, "session-compacted")).toBe(sessionFile);

  // Reloading from disk yields the exact same active LLM session context and settings.
  const reopened = SessionManager.open(sessionFile, sessionDir, workspaceDir);
  expect(reopened.getSessionId()).toBe("session-compacted");
  expect(reopened.buildSessionContext()).toEqual(contextBefore);
});

test("live CoforgeAgentRuntime rotateTranscript refuses uncompacted transcript and respects COFORGE_PI_SESSION_ROTATION_ENABLED", async () => {
  const disabledRuntime = await createSession({
    cwd: workspaceDir,
    agentId: "agent-live-rotate-disabled",
    apiKey: "test-only-not-a-provider-key",
    instructions: "Live session rotation disabled by default test",
    environment: { COFORGE_PI_SESSION_ROTATE_BYTES: "24000" },
  });
  try {
    for (let i = 0; i < 10; i++) {
      disabledRuntime.session.sessionManager.appendMessage(
        userMsg(`turn ${i}: ${"U".repeat(5_000)}`),
      );
      disabledRuntime.session.sessionManager.appendMessage(
        assistantMsg(`reply ${i}: ${"A".repeat(5_000)}`),
      );
    }
    disabledRuntime.session.refreshContext();
    expect(disabledRuntime.session.state.messages.length).toBe(20);

    await disabledRuntime.rotateTranscript();
    expect(disabledRuntime.session.state.messages.length).toBe(20);
  } finally {
    await disabledRuntime.dispose();
  }

  const enabledRuntime = await createSession({
    cwd: workspaceDir,
    agentId: "agent-live-rotate-enabled",
    apiKey: "test-only-not-a-provider-key",
    instructions: "Live session rotation uncompacted refusal test",
    environment: {
      COFORGE_PI_SESSION_ROTATION_ENABLED: "1",
      COFORGE_PI_SESSION_ROTATE_BYTES: "24000",
    },
  });
  try {
    for (let i = 0; i < 10; i++) {
      enabledRuntime.session.sessionManager.appendMessage(
        userMsg(`turn ${i}: ${"U".repeat(5_000)}`),
      );
      enabledRuntime.session.sessionManager.appendMessage(
        assistantMsg(`reply ${i}: ${"A".repeat(5_000)}`),
      );
    }
    enabledRuntime.session.refreshContext();
    await enabledRuntime.rotateTranscript();
    expect(enabledRuntime.session.state.messages.length).toBe(20);
  } finally {
    await enabledRuntime.dispose();
  }
});

test("rotatePiSessionTranscriptIfOversized preserves .rotated backup and refuses missing firstKeptEntryId or unknown entry types", async () => {
  const manager = SessionManager.create(workspaceDir, sessionDir, { id: "session-backup" });
  for (let i = 0; i < 6; i++) {
    manager.appendMessage(userMsg(`old ${i}: ${"U".repeat(5_000)}`));
    manager.appendMessage(assistantMsg(`old reply ${i}: ${"A".repeat(5_000)}`));
  }
  const keptId = manager.appendMessage(userMsg("kept turn"));
  manager.appendCompaction("Summary", keptId, 120_000);
  const sessionFile = manager.getSessionFile();
  expect(sessionFile).toBeTruthy();

  const rotated = await rotatePiSessionTranscriptIfOversized(manager, { maxBytes: 24_000 });
  expect(rotated.rotated).toBe(true);
  const backupStat = await stat(`${sessionFile}.rotated`);
  expect(backupStat.size).toBeGreaterThan(24_000);

  const missingKept = SessionManager.create(workspaceDir, sessionDir, {
    id: "session-missing-kept",
  });
  for (let i = 0; i < 6; i++) {
    missingKept.appendMessage(userMsg(`old ${i}: ${"U".repeat(5_000)}`));
  }
  missingKept.appendCompaction("Summary", "nonexistent-entry-id", 120_000);
  const missingResult = await rotatePiSessionTranscriptIfOversized(missingKept, {
    maxBytes: 24_000,
  });
  expect(missingResult.rotated).toBe(false);

  const unknownManager = SessionManager.create(workspaceDir, sessionDir, { id: "session-unknown" });
  for (let i = 0; i < 6; i++) {
    unknownManager.appendMessage(userMsg(`old ${i}: ${"U".repeat(5_000)}`));
  }
  const keptUnknownId = unknownManager.appendMessage(userMsg("kept turn"));
  unknownManager.appendCompaction("Summary", keptUnknownId, 120_000);
  const unknownFile = unknownManager.getSessionFile();
  expect(unknownFile).toBeTruthy();
  const original = await readFile(unknownFile!, "utf8");
  const { appendFile } = await import("node:fs/promises");
  await appendFile(
    unknownFile!,
    `${JSON.stringify({ type: "future_unknown_entry", id: "u-future", parentId: null, timestamp: new Date().toISOString() })}\n`,
  );
  const reloadedUnknown = SessionManager.open(unknownFile!, sessionDir);
  const unknownResult = await rotatePiSessionTranscriptIfOversized(reloadedUnknown, {
    maxBytes: 24_000,
  });
  expect(unknownResult.rotated).toBe(false);
  expect(await readFile(unknownFile!, "utf8")).toContain("future_unknown_entry");
  expect(original.length).toBeGreaterThan(0);
});
