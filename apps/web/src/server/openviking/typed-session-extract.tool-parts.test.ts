import { expect, test } from "bun:test";
import { createOpenVikingRuntimeClient, type FetchImpl } from "./runtime-client.server";
import {
  createOpenVikingTypedSessionExtract,
  type OpenVikingAdmittedSessionWrite,
} from "./typed-session-extract.server";

const SINK_IDENTITY = {
  accountId: "acct-ws-a",
  userId: "workspace-memory-sink",
  role: "user" as const,
  authorization: "Bearer server-held-sink",
};

const SAMPLE_WRITE: OpenVikingAdmittedSessionWrite = {
  sessionId: "coforge-quiet-ch-eng-m-live",
  workspaceId: "ws-a",
  tags: ["coforge_segment=quiet-ch-eng-m-live"],
  messages: [
    {
      role: "user",
      content: "standup note",
      createdAt: "2026-09-21T12:05:00.000Z",
      sourceMessageIds: ["m-live"],
    },
  ],
};

function channel(fetchImpl: FetchImpl) {
  return createOpenVikingTypedSessionExtract({
    runtime: createOpenVikingRuntimeClient({
      baseUrl: "http://ov.internal:1933",
      fetchImpl,
    }),
    authorizedOwner: "sink-owner",
    sinkIdentity: SINK_IDENTITY,
  });
}

test("tool exchanges become tool parts, deliveries and the evaluator verdict reach OpenViking", async () => {
  const captured: Array<{ url: string; body: string }> = [];
  const sessions = channel(async (input, init) => {
    captured.push({ url: String(input), body: String(init?.body ?? "") });
    return new Response(
      JSON.stringify({ status: "ok", result: { session_id: SAMPLE_WRITE.sessionId } }),
      { status: 200 },
    );
  });
  const result = await sessions.writeCommitAndExtract({
    owner: "sink-owner",
    write: {
      ...SAMPLE_WRITE,
      messages: [
        {
          ...SAMPLE_WRITE.messages[0]!,
          role: "assistant" as const,
          peerId: "coforge__task",
          toolExchanges: [
            { toolCallId: "c1", toolName: "bash", input: "ls", output: "a.txt", isError: true },
          ],
          deliveries: [{ participantId: "coforge__memory", notified: true, read: false }],
        },
      ],
      outcomeEvaluatorResults: [
        {
          bindingId: "b1",
          signalKind: "evaluator",
          signal: "fail",
          evidenceRef: "ref",
          reward: 0.3,
          feedback: "TOP IMPROVEMENTS NEEDED",
        },
      ],
    },
  });
  expect(result.ok).toBe(true);
  const batch = captured.find((row) => row.url.endsWith("/messages/batch"));
  const message = (JSON.parse(batch!.body) as { messages: Array<Record<string, unknown>> })
    .messages[0]!;
  const parts = message.parts as Array<Record<string, unknown>>;
  expect(parts[0]).toMatchObject({
    type: "tool",
    tool_id: "c1",
    tool_input: { value: "ls" },
    tool_status: "error",
  });
  expect(parts.at(-1)).toEqual({ type: "text", text: SAMPLE_WRITE.messages[0]!.content });
  expect(message.deliveries).toEqual([
    { participant_id: "coforge__memory", notified: true, read: false },
  ]);
  const commit = captured.find((row) => row.url.endsWith("/commit"));
  expect(JSON.parse(commit!.body).outcome_evaluator_results).toEqual([
    {
      binding_id: "b1",
      signal_kind: "evaluator",
      signal: "fail",
      evidence_ref: "ref",
      reward: 0.3,
      feedback: "TOP IMPROVEMENTS NEEDED",
    },
  ]);
});
