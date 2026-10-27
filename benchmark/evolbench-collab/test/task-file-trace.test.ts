import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportTaskFileTrace, appendTrailingObservations } from "../src/task-file-trace";
import { mkdir } from "node:fs/promises";

async function fixture(end: string) {
  const cwd = await mkdtemp(join(tmpdir(), "task-file-trace-"));
  await mkdir(join(cwd, ".builtin-sessions"));
  await Bun.write(
    join(cwd, "docker-task-runtime.json"),
    JSON.stringify({
      hostWorkspace: cwd,
      cwd: "/testbed",
      sessionDirectory: join(cwd, ".builtin-sessions"),
    }),
  );
  const messages = [
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "edit", name: "bash", arguments: { command: "edit source.py" } },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "edit",
      toolName: "bash",
      content: [{ type: "text", text: "edited" }],
      isError: false,
    },
  ];
  if (end === "held")
    messages.push(
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "send",
            name: "bash",
            arguments: { command: "coforge message send --target '#t'" },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "send",
        toolName: "bash",
        content: [{ type: "text", text: '{"accepted":false,"state":"held"}' }],
        isError: false,
      },
    );
  if (end === "quiet") messages.push({ role: "assistant", content: [] });
  if (end === "deadline")
    messages.push({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "pending",
          name: "bash",
          arguments: { command: "pytest slow_test.py" },
        },
      ],
    });
  const rows = [
    {
      type: "session",
      version: 3,
      id: "session-1",
      cwd: "/testbed",
      timestamp: "2026-10-25T00:00:00Z",
    },
    ...messages.map((message, i) => ({
      type: "message",
      id: `m${i}`,
      parentId: i ? `m${i - 1}` : null,
      timestamp: "2026-10-25T00:00:00Z",
      message,
    })),
  ];
  await Bun.write(
    join(cwd, ".builtin-sessions", "renamed.jsonl"),
    rows.map((x) => JSON.stringify(x)).join("\n") + "\n",
  );
  return cwd;
}

for (const ending of ["no_TASK_COMPLETE", "held", "quiet", "deadline"]) {
  test(`docker Task ${ending}: keep unpublished tail independently`, async () => {
    const cwd = await fixture(ending);
    try {
      const trace = await exportTaskFileTrace({ cwd, sessionId: "session-1" });
      expect(trace.sends).toEqual([]);
      expect(trace.trailingToolExchanges?.map((x) => x.toolCallId)).toEqual(
        ending === "held"
          ? ["edit", "send"]
          : ending === "deadline"
            ? ["edit", "pending"]
            : ["edit"],
      );
      const write = appendTrailingObservations(
        { sessionId: "ov", workspaceId: "w", tags: [], messages: [] },
        [
          {
            sessionId: trace.sessionId,
            participantId: "coforge__task",
            toolExchanges: trace.trailingToolExchanges!,
          },
        ],
      );
      expect(write.messages).toHaveLength(1);
      expect(write.messages[0]?.sourceMessageIds[0]).toStartWith("runtime-observation:");
      expect(write.messages[0]?.content).toContain("not published to channel");
      expect(write.messages[0]?.toolExchanges?.[0]?.toolCallId).toBe("edit");
      if (ending === "deadline") {
        expect(write.messages[0]?.toolExchanges).toHaveLength(1);
        expect(write.messages[0]?.content).toContain("completion unknown");
        expect(write.messages[0]?.content).toContain('"toolCallId":"pending"');
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
}

for (const mismatch of [
  "hostWorkspace",
  "cwd",
  "sessionDirectory",
  "sessionId",
  "duplicate",
  "malformed",
  "legacy_version",
]) {
  test(`identity mismatch ${mismatch} fails explicitly`, async () => {
    const cwd = await fixture("quiet");
    try {
      const metadata = join(cwd, "docker-task-runtime.json");
      if (["hostWorkspace", "cwd", "sessionDirectory"].includes(mismatch)) {
        const value = await Bun.file(metadata).json();
        value[mismatch] = "/wrong";
        await Bun.write(metadata, JSON.stringify(value));
      }
      const path = join(cwd, ".builtin-sessions", "renamed.jsonl");
      if (mismatch === "duplicate")
        await Bun.write(
          join(cwd, ".builtin-sessions", "duplicate.jsonl"),
          await Bun.file(path).text(),
        );
      if (mismatch === "legacy_version")
        await Bun.write(path, (await Bun.file(path).text()).replace('"version":3', '"version":2'));
      if (mismatch === "malformed") await Bun.write(path, "{bad json\n");
      await expect(
        exportTaskFileTrace({ cwd, sessionId: mismatch === "sessionId" ? "other" : "session-1" }),
      ).rejects.toThrow();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
}

test("legacy grouping stays byte identical unless trailing preservation is requested", async () => {
  const { channelTraceFromSteps } = await import("../../../packages/agent/src/channel-turn-trace");
  const steps = [
    {
      kind: "tool" as const,
      toolCallId: "t",
      toolName: "bash",
      input: {},
      output: "ok",
      isError: false,
    },
  ];
  expect(JSON.stringify(channelTraceFromSteps("s", steps))).toBe(
    '{"sessionId":"s","sends":[],"trailingReceivedShortIds":[]}',
  );
});

test("file trace survives load, derive and typed observation conversion", async () => {
  const { loadEnrichmentAgents, deriveTurnEnrichment } = await import("../src/enrichment");
  const cwd = await fixture("held");
  try {
    const agents = await loadEnrichmentAgents({
      agents: [{ id: "task", name: "task", cwd, sessionIds: ["session-1"] }],
      decisions: { read: () => [], append: () => {} },
      taskTraceFromFile: true,
    });
    const enrichment = deriveTurnEnrichment({
      agents,
      messages: [{ id: "prompt", senderAgentId: null }],
    });
    expect([...enrichment]).toEqual([]);
    expect(enrichment.trailingAnchorMessageId).toBe("prompt");
    const write = appendTrailingObservations(
      { sessionId: "ov", workspaceId: "w", tags: [], messages: [] },
      enrichment.trailingObservations!,
    );
    expect(write.messages[0]?.toolExchanges?.map((t) => t.toolCallId)).toEqual(["edit", "send"]);
    expect(write.messages[0]?.peerId).toBe("coforge__task");
    expect(write.messages[0]?.sourceMessageIds[0]).toStartWith("runtime-observation:");
    await expect(
      loadEnrichmentAgents({
        agents: [{ id: "task", name: "task", cwd, sessionIds: ["wrong"] }],
        decisions: { read: () => [], append: () => {} },
        taskTraceFromFile: true,
      }),
    ).rejects.toThrow();
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("typed writer appends the tail and deduplicates stable runtime identity", async () => {
  const { createOpenVikingTypedSessionExtract } =
    await import("../../../apps/web/src/server/openviking/typed-session-extract.server");
  const { createOpenVikingRuntimeClient } =
    await import("../../../apps/web/src/server/openviking/runtime-client.server");
  const { trajectorySessionWrite } = await import("../src/task-file-trace");
  const { deriveTurnEnrichment, loadEnrichmentAgents } = await import("../src/enrichment");
  const cwd = await fixture("held");
  try {
    const agents = await loadEnrichmentAgents({
      agents: [{ id: "task", name: "task", cwd, sessionIds: ["session-1"] }],
      decisions: { read: () => [], append: () => {} },
      taskTraceFromFile: true,
    });
    const turnEnrichment = deriveTurnEnrichment({
      agents,
      messages: [{ id: "prompt", senderAgentId: null }],
    });
    const delivery = {
      operationId: "ingest-seg",
      segment: {
        profileGeneration: 1,
        closedAt: "2026-10-25T00:00:00Z",
        segmentId: "seg",
        workspace: { workspaceId: "w", channelId: "c" },
        sourceMessageIds: ["prompt"],
        kind: "quiet_window",
        conversationKind: "public_channel",
        sourcePayloadHash: "hash",
      },
      turns: [
        {
          messageId: "prompt",
          sequence: 1,
          payloadHash: "h",
          senderHandle: "user",
          senderKind: "human",
          body: "Fix the bug",
          occurredAt: "2026-10-25T00:00:00Z",
        },
      ],
      turnEnrichment,
    } as Parameters<typeof trajectorySessionWrite>[0];
    const write = trajectorySessionWrite(delivery);
    const appended: any[] = [];
    const runtime = createOpenVikingRuntimeClient({
      baseUrl: "http://offline.invalid",
      fetchImpl: async (url, init) => {
        if (init?.method === "GET") return Response.json({ result: { messages: appended } });
        if (String(url).endsWith("/messages/batch"))
          appended.push(...JSON.parse(String(init?.body)).messages);
        return Response.json({ status: "ok", result: {} });
      },
    });
    const sessions = createOpenVikingTypedSessionExtract({
      runtime,
      authorizedOwner: "test",
      sinkIdentity: {
        accountId: "test",
        userId: "test",
        role: "user",
        authorization: "Bearer fake",
      },
      onPhase: () => {},
    });
    expect((await sessions.writeCommitAndExtract({ owner: "test", write })).ok).toBe(true);
    expect(appended).toHaveLength(2);
    expect(appended[1].parts[0].tool_id).toBe("edit");
    expect(appended[1].parts[1].tool_id).toBe("send");
    expect(appended[1].source_message_ids[0]).toStartWith("runtime-observation:");
    expect((await sessions.writeCommitAndExtract({ owner: "test", write })).ok).toBe(true);
    expect(appended).toHaveLength(2);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("full active branch retains pre-compaction tools without rewriting the source", async () => {
  const cwd = await fixture("quiet");
  const file = join(cwd, ".builtin-sessions", "renamed.jsonl");
  try {
    const extra = [
      {
        type: "compaction",
        id: "compact",
        parentId: "m1",
        firstKeptEntryId: "after",
        summary: "compacted",
        tokensBefore: 1000,
        timestamp: "2026-10-25T00:00:01Z",
      },
      {
        type: "message",
        id: "after",
        parentId: "compact",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", id: "test", name: "bash", arguments: { command: "pytest" } },
          ],
        },
      },
      {
        type: "message",
        id: "result",
        parentId: "after",
        message: {
          role: "toolResult",
          toolCallId: "test",
          toolName: "bash",
          content: [{ type: "text", text: "passed" }],
          isError: false,
        },
      },
    ];
    await Bun.write(
      file,
      (await Bun.file(file).text()) + extra.map((x) => JSON.stringify(x)).join("\n") + "\n",
    );
    const before = await Bun.file(file).text();
    expect(
      (await exportTaskFileTrace({ cwd, sessionId: "session-1" })).trailingToolExchanges?.map(
        (x) => x.toolCallId,
      ),
    ).toEqual(["edit", "test"]);
    expect(await Bun.file(file).text()).toBe(before);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("87 frozen SWE session shapes preserve send boundaries and residual tools", async () => {
  const { channelTraceFromSteps } = await import("../../../packages/agent/src/channel-turn-trace");
  const fixtureRoot = new URL("./fixtures/swe-task-session-shapes/", import.meta.url);
  const shapes = [];
  for (const name of new Bun.Glob("*.case.json").scanSync(fixtureRoot.pathname)) {
    const shape = await Bun.file(new URL(name, fixtureRoot)).json();
    shape.steps = (await Promise.all(shape.parts.map((part: string) => Bun.file(new URL(part, fixtureRoot)).json()))).flat();
    shapes.push(shape);
  }
  expect(shapes).toHaveLength(87);
  for (const shape of shapes) {
    const trace = channelTraceFromSteps(shape.sessionId, shape.steps, true);
    expect(trace.sends).toHaveLength(shape.sends);
    expect(trace.trailingToolExchanges).toHaveLength(shape.tail_tools);
  }
  expect(shapes.some((s: any) => !s.final_complete)).toBe(true);
  expect(shapes.some((s: any) => s.termination === "quiet_no_offer")).toBe(true);
});
