import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUNTIME_PROVIDER, RUNTIME_PROVIDER_VALUES } from "@lrm/coforge-sdk/internal";
import {
  AGENT_CONTEXT_VIEW_AVAILABILITY_REFRESH_JITTER_MS,
  AGENT_CONTEXT_VIEW_AVAILABILITY_REFRESH_MAX_MS,
  AgentContextViewService,
  agentContextViewAvailabilityRefreshDelay,
} from "#src/agent-context-view/agent-context-view-service";
import {
  AGENT_CONTEXT_INDEX_MAX_BYTES,
  ContextViewStore,
} from "#src/agent-context-view/context-view-store";

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

test("startup maintenance enumerates disk stores and compacts old entries", () => {
  const root = mkdtempSync(join(tmpdir(), "coforge-context-service-"));
  const log = join(root, "pi-requests.jsonl");
  writeFileSync(log, '{"type":"request"}\n', "utf8");
  const service = new AgentContextViewService({
    stateDirectory: root,
    workspaceRoot: root,
    serverId: "server-1",
    workspaceId: "workspace-1",
    computerId: "computer-1",
    now: () => 31 * 24 * 60 * 60 * 1000,
  });
  const store = new ContextViewStore(root, "server-1", "agent-1", () => 31 * 24 * 60 * 60 * 1000);
  store.record({
    messageId: "message-1",
    sentAt: new Date(0).toISOString(),
    runtime: "pi",
    sessionId: "session-1",
    transcript: "pi-requests.jsonl",
    offset: 1,
  });
  service.compactAndSweep();
  expect(existsSync(store.indexPath)).toBe(false);
});

test("restart maintenance sweeps request logs from the managed state directory", () => {
  const root = mkdtempSync(join(tmpdir(), "coforge-context-service-"));
  try {
    const now = 31 * 24 * 60 * 60 * 1000;
    const first = new AgentContextViewService({
      stateDirectory: root,
      serverId: "server-1",
      workspaceId: "workspace-1",
      computerId: "computer-1",
      now: () => 1_000,
    });
    const store = new ContextViewStore(root, "server-1", "agent-1", () => now);
    store.record({ ...entryForRequestLog(), sentAt: new Date(1_000).toISOString() });
    const log = join(store.requestLogDirectory, "session-1.jsonl");
    writeFileSync(log, '{"type":"request"}\n', "utf8");
    utimesSync(log, new Date(1), new Date(1));
    first.compactAndSweep();

    const restarted = new AgentContextViewService({
      stateDirectory: root,
      serverId: "server-1",
      workspaceId: "workspace-1",
      computerId: "computer-1",
      now: () => now,
    });
    restarted.compactAndSweep();
    expect(() => readFileSync(log, "utf8")).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restart maintenance removes managed request logs after the off grace", () => {
  const root = mkdtempSync(join(tmpdir(), "coforge-context-service-"));
  try {
    const offAt = 1_000;
    const first = new AgentContextViewService({
      stateDirectory: root,
      serverId: "server-1",
      workspaceId: "workspace-1",
      computerId: "computer-1",
      now: () => offAt,
    });
    const store = new ContextViewStore(root, "server-1", "agent-1", () => offAt);
    store.record(entryForRequestLog());
    const log = join(store.requestLogDirectory, "session-1.jsonl");
    writeFileSync(log, '{"type":"request"}\n', "utf8");
    store.markOff(offAt);
    first.compactAndSweep();

    const restarted = new AgentContextViewService({
      stateDirectory: root,
      serverId: "server-1",
      workspaceId: "workspace-1",
      computerId: "computer-1",
      now: () => offAt + 24 * 60 * 60 * 1000,
    });
    restarted.compactAndSweep();
    expect(() => readFileSync(log, "utf8")).toThrow();
    expect(ContextViewStore.exists(root, "server-1", "agent-1")).toBe(false);
    restarted.compactAndSweep();
    expect(ContextViewStore.exists(root, "server-1", "agent-1")).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function entryForRequestLog() {
  return {
    messageId: "message-request-log",
    sentAt: new Date(1_000).toISOString(),
    runtime: "pi" as const,
    sessionId: "session-1",
    transcript: "agent-context/server-1/agent-1/pi-requests/session-1.jsonl",
    offset: 1,
  };
}

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

describe("the provider value an Agent's launch config carries", () => {
  // task #739: the gate used to name its own runtimes ("claude", "builtin", "kimi-sdk"), which
  // no Agent config ever holds — its `provider` is a RuntimeProvider value. Claude Code and the
  // built-in Agent therefore reported unsupported_runtime forever.
  const markers: Record<string, string> = {
    [RUNTIME_PROVIDER.CLAUDE_CODE]: '{"type":"api-request"}',
    [RUNTIME_PROVIDER.CODEX]: '{"type":"additional_tools"}',
    [RUNTIME_PROVIDER.PI]: '{"type":"request",}',
    [RUNTIME_PROVIDER.COFORGE]: '{"type":"request",}',
    "kimi-sdk": '{"type":"llm.request"}',
  };
  test.each(Object.keys(markers))(
    "indexes a %s Agent's request log and reports it supported",
    (provider) => {
      const root = mkdtempSync(join(tmpdir(), "coforge-context-service-"));
      const transcript = join(root, "session.jsonl");
      writeFileSync(transcript, markers[provider]!, "utf8");
      const reports: Array<Record<string, unknown>> = [];
      const service = new AgentContextViewService({
        stateDirectory: root,
        serverId: "server-1",
        workspaceId: "workspace-1",
        computerId: "computer-1",
        reportAvailability: (value) => reports.push(value as Record<string, unknown>),
      });
      service.reportAvailability({
        agentId: "agent-1",
        runtime: provider,
        sessionId: "session-1",
        transcript: "session.jsonl",
        transcriptPath: transcript,
      });
      expect(reports).toEqual([expect.objectContaining({ runtime: provider, supported: true })]);
    },
  );

  const unsupported = RUNTIME_PROVIDER_VALUES.filter((provider) => markers[provider] === undefined);
  test.each(unsupported)("reports %s as unsupported_runtime", (provider) => {
    const root = mkdtempSync(join(tmpdir(), "coforge-context-service-"));
    const reports: Array<Record<string, unknown>> = [];
    const service = new AgentContextViewService({
      stateDirectory: root,
      serverId: "server-1",
      workspaceId: "workspace-1",
      computerId: "computer-1",
      reportAvailability: (value) => reports.push(value as Record<string, unknown>),
    });
    service.reportAvailability({ agentId: "agent-1", runtime: provider });
    expect(reports).toEqual([
      expect.objectContaining({
        runtime: provider,
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

test("refreshes availability after the Raft maximum interval", () => {
  const root = mkdtempSync(join(tmpdir(), "coforge-context-service-"));
  const transcript = join(root, "session.jsonl");
  writeFileSync(transcript, '{"type":"additional_tools"}', "utf8");
  const reports: unknown[] = [];
  let now = 1_000;
  const service = new AgentContextViewService({
    stateDirectory: root,
    serverId: "server-1",
    workspaceId: "workspace-1",
    computerId: "computer-1",
    now: () => now,
    reportAvailability: (value) => reports.push(value),
  });
  const facts = {
    agentId: "agent-1",
    runtime: "codex",
    sessionId: "session-1",
    transcript: "session.jsonl",
    transcriptPath: transcript,
  };
  service.reportAvailability(facts);
  now += 23 * 60 * 60 * 1000;
  service.compactAndSweep();
  expect(reports).toHaveLength(1);
  now += 2 * 60 * 60 * 1000;
  service.compactAndSweep();
  expect(reports).toHaveLength(2);
  expect(reports.at(-1)).toEqual(expect.objectContaining({ trigger: "periodic" }));
});

test("uses Raft's 20-to-24-hour availability refresh jitter", () => {
  expect(agentContextViewAvailabilityRefreshDelay(() => 0)).toBe(
    AGENT_CONTEXT_VIEW_AVAILABILITY_REFRESH_MAX_MS -
      AGENT_CONTEXT_VIEW_AVAILABILITY_REFRESH_JITTER_MS,
  );
  expect(agentContextViewAvailabilityRefreshDelay(() => 1)).toBe(
    AGENT_CONTEXT_VIEW_AVAILABILITY_REFRESH_MAX_MS -
      AGENT_CONTEXT_VIEW_AVAILABILITY_REFRESH_JITTER_MS +
      Math.floor(0.999999 * AGENT_CONTEXT_VIEW_AVAILABILITY_REFRESH_JITTER_MS),
  );
});

test("re-reports availability when retention drops indexed rows", () => {
  const root = mkdtempSync(join(tmpdir(), "coforge-context-service-"));
  try {
    const transcript = join(root, "session.jsonl");
    writeFileSync(transcript, '{"type":"additional_tools"}', "utf8");
    const now = 31 * 24 * 60 * 60 * 1000;
    const store = new ContextViewStore(root, "server-1", "agent-1", () => now);
    store.record({
      messageId: "message-old",
      sentAt: new Date(0).toISOString(),
      runtime: "codex",
      sessionId: "session-1",
      transcript: "session.jsonl",
      offset: 27,
    });
    const reports: unknown[] = [];
    const service = new AgentContextViewService({
      stateDirectory: root,
      serverId: "server-1",
      workspaceId: "workspace-1",
      computerId: "computer-1",
      now: () => now,
      reportAvailability: (value) => reports.push(value),
    });
    service.reportAvailability(
      {
        agentId: "agent-1",
        runtime: "codex",
        sessionId: "session-1",
        transcript: "session.jsonl",
        transcriptPath: transcript,
      },
      true,
    );
    service.compactAndSweep();
    expect(reports.at(-1)).toEqual(
      expect.objectContaining({ supported: true, trigger: "retention" }),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reports supported from retained index data when the current transcript is unavailable", () => {
  const root = mkdtempSync(join(tmpdir(), "coforge-context-service-"));
  try {
    const now = 1_000;
    const store = new ContextViewStore(root, "server-1", "agent-1", () => now);
    store.record({
      messageId: "message-retained",
      sentAt: new Date(now).toISOString(),
      runtime: "codex",
      sessionId: "session-1",
      transcript: "session.jsonl",
      offset: 27,
    });
    const reports: unknown[] = [];
    const service = new AgentContextViewService({
      stateDirectory: root,
      serverId: "server-1",
      workspaceId: "workspace-1",
      computerId: "computer-1",
      now: () => now,
      reportAvailability: (value) => reports.push(value),
    });
    service.reportAvailability({ agentId: "agent-1", runtime: "codex" }, true);
    expect(reports).toEqual([
      expect.objectContaining({
        supported: true,
        retainedSince: new Date(now).toISOString(),
      }),
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("re-reports retention when the index cap drops duplicate-timestamp rows", () => {
  const root = mkdtempSync(join(tmpdir(), "coforge-context-service-"));
  try {
    const now = 1_000;
    const store = new ContextViewStore(root, "server-1", "agent-1", () => now);
    const sentAt = new Date(now).toISOString();
    const sample = `${JSON.stringify({
      messageId: "message-000000",
      sentAt,
      runtime: "codex",
      sessionId: "session-1",
      transcript: "session.jsonl",
      offset: 27,
    })}\n`;
    const count = Math.ceil((AGENT_CONTEXT_INDEX_MAX_BYTES * 1.1) / Buffer.byteLength(sample));
    writeFileSync(
      store.indexPath,
      Array.from(
        { length: count },
        (_, index) =>
          `${JSON.stringify({
            messageId: `message-${String(index).padStart(6, "0")}`,
            sentAt,
            runtime: "codex",
            sessionId: "session-1",
            transcript: "session.jsonl",
            offset: 27,
          })}\n`,
      ).join(""),
      "utf8",
    );
    const transcript = join(root, "session.jsonl");
    writeFileSync(transcript, '{"type":"additional_tools"}', "utf8");
    const reports: unknown[] = [];
    const service = new AgentContextViewService({
      stateDirectory: root,
      serverId: "server-1",
      workspaceId: "workspace-1",
      computerId: "computer-1",
      now: () => now,
      reportAvailability: (value) => reports.push(value),
    });
    service.reportAvailability(
      {
        agentId: "agent-1",
        runtime: "codex",
        sessionId: "session-1",
        transcript: "session.jsonl",
        transcriptPath: transcript,
      },
      true,
    );
    service.compactAndSweep();
    expect(reports.at(-1)).toEqual(
      expect.objectContaining({ supported: true, trigger: "retention" }),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
