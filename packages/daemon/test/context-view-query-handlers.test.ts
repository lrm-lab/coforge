import { expect, test } from "bun:test";
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
