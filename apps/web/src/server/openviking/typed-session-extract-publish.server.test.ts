import { expect, test } from "bun:test";
import { createOpenVikingRuntimeClient } from "./runtime-client.server";
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
  tags: [
    "coforge_segment=quiet-ch-eng-m-live",
    "coforge_workspace=ws-a",
    "coforge_channel=ch-eng",
    "coforge_kind=quiet_window",
    "coforge_source_message_ids=m-live",
  ],
  messages: [
    {
      role: "user",
      content: "standup note",
      createdAt: "2026-09-21T12:05:00.000Z",
      sourceMessageIds: ["m-live"],
    },
  ],
};

function headersFrom(init: RequestInit | undefined): Record<string, string> {
  const headers = new Headers(init?.headers);
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    out[name.toLowerCase()] = value;
  });
  return out;
}

test("causal publication follows settled commit when explicitly enabled by an admin sink", async () => {
  const calls: string[] = [];
  const sessions = createOpenVikingTypedSessionExtract({
    runtime: createOpenVikingRuntimeClient({
      baseUrl: "http://ov.internal:1933",
      fetchImpl: async (input, init) => {
        const path = new URL(String(input)).pathname;
        calls.push(path);
        const result = path.endsWith("/commit")
          ? { task_id: "task-publish" }
          : path.endsWith("/tasks/task-publish")
            ? { status: "completed" }
            : path.endsWith("/publish_causal")
              ? { resources: 6, retrieval_mode: "bm25" }
              : {};
        if (path.endsWith("/publish_causal")) {
          expect(JSON.parse(String(init?.body))).toEqual({ session_id: SAMPLE_WRITE.sessionId });
          expect(headersFrom(init)["x-openviking-user"]).toBe(SINK_IDENTITY.userId);
        }
        return new Response(JSON.stringify({ status: "ok", result }), { status: 200 });
      },
    }),
    authorizedOwner: "sink-owner",
    sinkIdentity: { ...SINK_IDENTITY, role: "admin" },
    publishCausal: true,
    sleep: async () => undefined,
    onPhase: () => undefined,
  });
  expect(await sessions.writeCommitAndExtract({ owner: "sink-owner", write: SAMPLE_WRITE })).toEqual(
    { ok: true, sessionId: SAMPLE_WRITE.sessionId },
  );
  expect(calls.slice(-2)).toEqual(["/api/v1/tasks/task-publish", "/api/v1/search/publish_causal"]);
});
