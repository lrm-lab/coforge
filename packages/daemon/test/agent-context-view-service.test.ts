import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentContextViewService } from "#src/agent-context-view/agent-context-view-service";

test("indexes a committed message at the native transcript size and reports availability once", () => {
  const root = mkdtempSync(join(tmpdir(), "coforge-context-service-"));
  const transcript = join(root, "session.jsonl");
  writeFileSync(transcript, '{"type":"additional_tools"}', "utf8");
  const availability: unknown[] = [];
  const service = new AgentContextViewService({
    stateDirectory: root,
    serverId: "server-1",
    workspaceId: "workspace-1",
    computerId: "computer-1",
    now: () => 1_000,
    reportAvailability: (value) => availability.push(value),
  });
  service.onMessageCommitted(
    {
      agentId: "agent-1",
      runtime: "codex",
      sessionId: "session-1",
      transcript: "session.jsonl",
      transcriptPath: transcript,
    },
    "message-1",
    true,
  );
  service.onMessageCommitted(
    {
      agentId: "agent-1",
      runtime: "codex",
      sessionId: "session-1",
      transcript: "session.jsonl",
      transcriptPath: transcript,
    },
    "message-2",
    true,
  );
  expect(availability).toHaveLength(1);
  expect(
    JSON.parse(
      readFileSync(join(root, "agent-context", "server-1", "agent-1", "index.jsonl"), "utf8").split(
        "\n",
      )[0]!,
    ).offset,
  ).toBe(27);
});

test("does not create unknown agent state and hides moved agent data after disable", () => {
  const root = mkdtempSync(join(tmpdir(), "coforge-context-service-"));
  const transcript = join(root, "session.jsonl");
  writeFileSync(transcript, '{"type":"additional_tools"}', "utf8");
  const service = new AgentContextViewService({
    stateDirectory: root,
    serverId: "server-1",
    workspaceId: "workspace-1",
    computerId: "computer-1",
  });
  expect(service.find("missing-agent", "message-1")).toBeUndefined();
  service.onMessageCommitted(
    {
      agentId: "agent-1",
      runtime: "codex",
      sessionId: "session-1",
      transcript: "session.jsonl",
      transcriptPath: transcript,
    },
    "message-1",
    true,
  );
  service.disable("agent-1");
  expect(service.find("agent-1", "message-1")).toBeUndefined();
});

describe("unsupported context view runtimes", () => {
  test("reports unsupported_runtime without writing an index", () => {
    const root = mkdtempSync(join(tmpdir(), "coforge-context-service-"));
    const reports: unknown[] = [];
    const service = new AgentContextViewService({
      stateDirectory: root,
      serverId: "server-1",
      workspaceId: "workspace-1",
      computerId: "computer-1",
      reportAvailability: (value) => reports.push(value),
    });
    service.onMessageCommitted(
      {
        agentId: "agent-1",
        runtime: "other-runtime",
        sessionId: "session-1",
        transcript: join(root, "x"),
      },
      "message-1",
      true,
    );
    expect(reports).toEqual([
      expect.objectContaining({ supported: false, unsupportedReason: "unsupported_runtime" }),
    ]);
  });

  test("reports unsupported runtimes without a transcript seam", () => {
    const root = mkdtempSync(join(tmpdir(), "coforge-context-service-"));
    const reports: unknown[] = [];
    const service = new AgentContextViewService({
      stateDirectory: root,
      serverId: "server-1",
      workspaceId: "workspace-1",
      computerId: "computer-1",
      reportAvailability: (value) => reports.push(value),
    });
    service.reportAvailability({ agentId: "agent-kimi", runtime: "kimi" });
    service.reportAvailability({ agentId: "agent-kimi-coding", runtime: "kimi-coding" });
    expect(reports).toEqual([
      expect.objectContaining({
        runtime: "kimi",
        supported: false,
        unsupportedReason: "unsupported_runtime",
      }),
      expect.objectContaining({
        runtime: "kimi-coding",
        supported: false,
        unsupportedReason: "unsupported_runtime",
      }),
    ]);
  });
});

test("records the server feature trigger on a gate-on availability report", () => {
  const root = mkdtempSync(join(tmpdir(), "coforge-context-service-"));
  const reports: unknown[] = [];
  const service = new AgentContextViewService({
    stateDirectory: root,
    serverId: "server-1",
    workspaceId: "workspace-1",
    computerId: "computer-1",
    reportAvailability: (value) => reports.push(value),
  });
  service.reportAvailability(
    { agentId: "agent-1", runtime: "codex", sessionId: "session-1" },
    true,
    "server_features",
  );
  expect(reports).toEqual([expect.objectContaining({ trigger: "server_features" })]);
});
