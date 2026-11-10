import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentContextViewRequest, AgentContextViewResult } from "@lrm/coforge-sdk/internal";
import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";
import { subscribeContextViewQueries } from "#src/daemon-runtime/context-view-query-handlers";
import { captureDaemonLogs } from "./log-capture";

const request: AgentContextViewRequest = {
  protocolMajor: 1,
  requestId: "ctxv_1234567890123456",
  workspaceId: "workspace-1",
  computerId: "computer-1",
  agentId: "agent-1",
  messageId: "message-1",
  sessionId: "session-1",
  maxBytes: 1024,
};

test("context view failures emit the same diagnostic result trace as successful restores", async () => {
  let receive: ((request: AgentContextViewRequest) => Promise<void>) | undefined;
  const results: AgentContextViewResult[] = [];
  const transport = {
    onAgentContextView(callback: (request: AgentContextViewRequest) => Promise<void>) {
      receive = callback;
      return () => {};
    },
    async postAgentContextViewResult(result: AgentContextViewResult) {
      results.push(result);
      return { postedBytes: 321, compressedBytes: 123, httpStatus: 204 };
    },
  } as unknown as DaemonConnectionClient;

  const { records } = await captureDaemonLogs(async () => {
    subscribeContextViewQueries(transport, {
      connection: {
        workspaceId: request.workspaceId,
        computerId: request.computerId,
        workspaceRoot: "/tmp/workspace",
      } as never,
      stateDirectory: "/tmp/state",
      contextView: { find: () => undefined },
      agentApiKey: () => "agent-key",
      currentTransport: () => transport,
      isStopping: () => false,
    });
    await receive?.(request);
  });

  expect(results[0]).toMatchObject({ status: "failed", reason: "not_found" });
  expect(
    records.find((record) => record.properties.event === "context_view:result")?.properties,
  ).toMatchObject({
    outcome: "failed",
    failure_detail: "not_found",
    post_outcome: "accepted",
    posted_bytes: 321,
    compressed_bytes: 123,
    http_status: 204,
    request_id: request.requestId,
    duration_ms: expect.any(Number),
  });
});

test("unexpected restore exceptions upload a read_failed result before tracing", async () => {
  let receive: ((request: AgentContextViewRequest) => Promise<void>) | undefined;
  const results: AgentContextViewResult[] = [];
  const transport = {
    onAgentContextView(callback: (request: AgentContextViewRequest) => Promise<void>) {
      receive = callback;
      return () => {};
    },
    async postAgentContextViewResult(result: AgentContextViewResult) {
      results.push(result);
    },
  } as unknown as DaemonConnectionClient;

  const { records } = await captureDaemonLogs(async () => {
    subscribeContextViewQueries(transport, {
      connection: {
        workspaceId: request.workspaceId,
        computerId: request.computerId,
        workspaceRoot: "/tmp/workspace",
      } as never,
      stateDirectory: "/tmp/state",
      contextView: {
        find: () => {
          throw new Error("restore exploded");
        },
      },
      agentApiKey: () => "agent-key",
      currentTransport: () => transport,
      isStopping: () => false,
    });
    await receive?.(request);
  });

  expect(results[0]).toMatchObject({
    status: "failed",
    reason: "read_failed",
    failureDetail: "exception",
  });
  expect(
    records.find((record) => record.properties.event === "context_view:result")?.properties,
  ).toMatchObject({
    outcome: "failed",
    failure_detail: "exception",
    post_outcome: "accepted",
    error_class: "Error",
  });
});

test("queued requests emit the Raft request_expired event with queued_ms", async () => {
  let receive: ((request: AgentContextViewRequest) => Promise<void>) | undefined;
  const transport = {
    onAgentContextView(callback: (request: AgentContextViewRequest) => Promise<void>) {
      receive = callback;
      return () => {};
    },
  } as unknown as DaemonConnectionClient;
  const originalNow = Date.now;
  try {
    Date.now = () => 0;
    const { records } = await captureDaemonLogs(async () => {
      subscribeContextViewQueries(transport, {
        connection: {
          workspaceId: request.workspaceId,
          computerId: request.computerId,
          workspaceRoot: "/tmp/workspace",
        } as never,
        stateDirectory: "/tmp/state",
        contextView: { find: () => undefined },
        currentTransport: () => transport,
        isStopping: () => false,
      });
      const pending = receive?.(request);
      Date.now = () => 23_000;
      await pending;
    });
    expect(
      records.find(
        (record) => record.properties.event === "daemon.agent_context_view.request_expired",
      )?.properties,
    ).toMatchObject({ agent_id: request.agentId, queued_ms: 23_000 });
  } finally {
    Date.now = originalNow;
  }
});

test("repeated reads reuse a short-lived, source-fingerprinted restore result", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-context-view-cache-"));
  const sourcePath = join(root, "session.jsonl");
  await writeFile(sourcePath, '{"type":"request","sessionId":"session-1"}\n');
  await chmod(sourcePath, 0o600);
  let receive: ((request: AgentContextViewRequest) => Promise<void>) | undefined;
  const results: AgentContextViewResult[] = [];
  let restores = 0;
  const transport = {
    onAgentContextView(callback: (request: AgentContextViewRequest) => Promise<void>) {
      receive = callback;
      return () => {};
    },
    async postAgentContextViewResult(result: AgentContextViewResult) {
      results.push(result);
    },
  } as unknown as DaemonConnectionClient;
  try {
    subscribeContextViewQueries(transport, {
      connection: {
        workspaceId: request.workspaceId,
        computerId: request.computerId,
        workspaceRoot: root,
      } as never,
      stateDirectory: root,
      contextView: {
        find: () => ({
          messageId: request.messageId,
          sentAt: "2026-01-01T00:00:00.000Z",
          runtime: "pi",
          sessionId: request.sessionId,
          transcript: "session.jsonl",
          offset: 42,
        }),
      },
      resolveProviderSource: () => sourcePath,
      agentApiKey: () => "agent-key",
      currentTransport: () => transport,
      isStopping: () => false,
      restoreInChild: async () => {
        restores++;
        return {
          ok: true,
          view: {
            runtime: "pi",
            sessionId: request.sessionId,
            messageId: request.messageId,
            messages: [],
            source: { kind: "captured", format: "pi" },
            redactions: { media: 0, diagnostic: 0 },
            responseFound: true,
          },
        };
      },
    });
    await receive?.(request);
    await receive?.({ ...request, requestId: "ctxv_1234567890123457" });
    expect(restores).toBe(1);
    expect(results).toHaveLength(2);
    expect(results.every((result) => result.status === "ok")).toBe(true);
    await writeFile(sourcePath, '{"type":"request","sessionId":"session-1"}\n\n');
    await receive?.({ ...request, requestId: "ctxv_1234567890123458" });
    expect(restores).toBe(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
