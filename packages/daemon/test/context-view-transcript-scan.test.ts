import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentContextViewService } from "#src/agent-context-view/agent-context-view-service";

test("detects a provider marker straddling the 64 KiB chunk scan boundary", () => {
  const root = mkdtempSync(join(tmpdir(), "coforge-context-boundary-"));
  try {
    const transcript = join(root, "session.jsonl");
    const prefix = "a".repeat(64 * 1024 - 5);
    writeFileSync(transcript, `${prefix}{"type":"additional_tools"}\n`, "utf8");
    const service = new AgentContextViewService({
      stateDirectory: root,
      serverId: "server-1",
      workspaceId: "workspace-1",
      computerId: "computer-1",
      now: () => 1_000,
    });
    service.onMessageCommitted(
      {
        agentId: "agent-1",
        runtime: "codex",
        sessionId: "session-1",
        transcript: "session.jsonl",
        transcriptPath: transcript,
      },
      "message-boundary",
      true,
    );
    expect(service.find("agent-1", "message-boundary")).toBeDefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("enforces the exact 8 MiB scan bound for transcript support detection", () => {
  const root = mkdtempSync(join(tmpdir(), "coforge-context-bound-"));
  try {
    const marker = Buffer.from('"type":"additional_tools"', "utf8");
    const atEnd = join(root, "at-end.jsonl");
    writeFileSync(
      atEnd,
      Buffer.concat([Buffer.alloc(8 * 1024 * 1024 - marker.length, 0x61), marker]),
    );
    const beyond = join(root, "beyond.jsonl");
    writeFileSync(
      beyond,
      Buffer.concat([Buffer.alloc(8 * 1024 * 1024 - marker.length + 1, 0x61), marker]),
    );

    const reports: unknown[] = [];
    const service = new AgentContextViewService({
      stateDirectory: root,
      serverId: "server-1",
      workspaceId: "workspace-1",
      computerId: "computer-1",
      now: () => 1_000,
      reportAvailability: (value) => reports.push(value),
    });

    service.onMessageCommitted(
      {
        agentId: "agent-1",
        runtime: "codex",
        sessionId: "session-1",
        transcript: "at-end.jsonl",
        transcriptPath: atEnd,
      },
      "message-at-end",
      true,
    );
    expect(service.find("agent-1", "message-at-end")).toBeDefined();

    service.onMessageCommitted(
      {
        agentId: "agent-2",
        runtime: "codex",
        sessionId: "session-2",
        transcript: "beyond.jsonl",
        transcriptPath: beyond,
      },
      "message-beyond",
      true,
    );
    expect(service.find("agent-2", "message-beyond")).toBeUndefined();
    expect(reports.at(-1)).toEqual(
      expect.objectContaining({
        agentId: "agent-2",
        supported: false,
        unsupportedReason: "no_session",
      }),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("re-verifies a cached transcript when overwritten in place and picks up a newly appended marker", () => {
  const root = mkdtempSync(join(tmpdir(), "coforge-context-reverify-"));
  try {
    const transcript = join(root, "session.jsonl");
    writeFileSync(transcript, '{"type":"session_meta"}\n', "utf8");
    const reports: Array<Record<string, unknown>> = [];
    const service = new AgentContextViewService({
      stateDirectory: root,
      serverId: "server-1",
      workspaceId: "workspace-1",
      computerId: "computer-1",
      now: () => 1_000,
      reportAvailability: (value) => reports.push(value as Record<string, unknown>),
    });
    const facts = {
      agentId: "agent-1",
      runtime: "codex",
      sessionId: "session-1",
      transcript: "session.jsonl",
      transcriptPath: transcript,
    };

    service.onMessageCommitted(facts, "m-no-marker", true);
    expect(service.find("agent-1", "m-no-marker")).toBeUndefined();

    writeFileSync(transcript, '{"type":"additional_tools"}\n', { encoding: "utf8", flag: "a" });
    service.onMessageCommitted(facts, "m-has-marker", true);
    expect(service.find("agent-1", "m-has-marker")?.offset).toBe(52);

    writeFileSync(transcript, '{"type":"response"}\n', { encoding: "utf8", flag: "a" });
    service.onMessageCommitted(facts, "m-appended", true);
    expect(service.find("agent-1", "m-appended")?.offset).toBe(72);

    writeFileSync(transcript, `${"z".repeat(200)}\n`, "utf8");
    service.onMessageCommitted(facts, "m-overwritten", true);
    expect(service.find("agent-1", "m-overwritten")).toBeUndefined();
    expect(reports.at(-1)).toEqual(
      expect.objectContaining({ supported: false, unsupportedReason: "no_session" }),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a symlinked transcript even after an earlier regular file at the same path was cached", () => {
  const root = mkdtempSync(join(tmpdir(), "coforge-context-symlink-"));
  try {
    const transcript = join(root, "session.jsonl");
    const target = join(root, "target.jsonl");
    writeFileSync(transcript, '{"type":"additional_tools"}\n', "utf8");
    writeFileSync(target, '{"type":"additional_tools"}\n', "utf8");
    const service = new AgentContextViewService({
      stateDirectory: root,
      serverId: "server-1",
      workspaceId: "workspace-1",
      computerId: "computer-1",
      now: () => 1_000,
    });
    const facts = {
      agentId: "agent-1",
      runtime: "codex",
      sessionId: "session-1",
      transcript: "session.jsonl",
      transcriptPath: transcript,
    };
    service.onMessageCommitted(facts, "m-1", true);
    expect(service.find("agent-1", "m-1")).toBeDefined();

    rmSync(transcript);
    symlinkSync(target, transcript);
    service.onMessageCommitted(facts, "m-2", true);
    expect(service.find("agent-1", "m-2")).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
