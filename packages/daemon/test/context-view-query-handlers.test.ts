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

test("a request queued past the deadline is answered expired instead of dropped", async () => {
  // Dropping it told the page nothing, so it polled out its own 30 second deadline and reported
  // an old daemon — the computer was merely busy (task #18).
  let receive: ((request: AgentContextViewRequest) => Promise<void>) | undefined;
  const results: AgentContextViewResult[] = [];
  let releaseSlowPost: (() => void) | undefined;
  const slowPost = new Promise<void>((resolve) => {
    releaseSlowPost = resolve;
  });
  const transport = {
    onAgentContextView(callback: (request: AgentContextViewRequest) => Promise<void>) {
      receive = callback;
      return () => {};
    },
    async postAgentContextViewResult(result: AgentContextViewResult) {
      // The first answer's upload is held, which is what makes the second request wait.
      if (results.length === 0) await slowPost;
      results.push(result);
      return { postedBytes: 1, httpStatus: 204 };
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
        agentApiKey: () => "agent-key",
        currentTransport: () => transport,
        isStopping: () => false,
      });
      const first = receive?.(request);
      const second = receive?.({ ...request, requestId: "ctxv_second_request_01" });
      // Both arrive together; the first Agent's upload is held, so the second waits in the queue
      // until the page would already be most of the way through its 30 second window.
      Date.now = () => 23_000;
      releaseSlowPost?.();
      await Promise.all([first, second]);
    });
    const expired = results.find((result) => result.requestId === "ctxv_second_request_01");
    expect(expired).toMatchObject({ status: "failed", reason: "expired" });
    expect(expired?.failureDetail).toBe("queue_deadline");
    expect(
      records.find(
        (record) =>
          record.properties.event === "context_view:result" &&
          record.properties.request_id === "ctxv_second_request_01",
      )?.properties,
    ).toMatchObject({
      outcome: "failed",
      failure_detail: "queue_deadline",
      post_outcome: "accepted",
    });
  } finally {
    Date.now = originalNow;
  }
});

test("a slow Agent's restore does not expire another Agent's request", async () => {
  // One chain for the whole Computer made every Agent queue behind whichever restore was running.
  let receive: ((request: AgentContextViewRequest) => Promise<void>) | undefined;
  const posted: AgentContextViewResult[] = [];
  let releaseSlowPost: (() => void) | undefined;
  const slowPost = new Promise<void>((resolve) => {
    releaseSlowPost = resolve;
  });
  const transport = {
    onAgentContextView(callback: (request: AgentContextViewRequest) => Promise<void>) {
      receive = callback;
      return () => {};
    },
    async postAgentContextViewResult(result: AgentContextViewResult) {
      if (result.agentId === request.agentId) await slowPost;
      posted.push(result);
      return { postedBytes: 1, httpStatus: 204 };
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
        agentApiKey: () => "agent-key",
        currentTransport: () => transport,
        isStopping: () => false,
      });
      const slow = receive?.(request);
      Date.now = () => 1_000;
      const other = receive?.({
        ...request,
        requestId: "ctxv_other_agent_request_01",
        agentId: "agent-2",
        messageId: "message-2",
      });
      await other;
      Date.now = () => 24_000;
      releaseSlowPost?.();
      await slow;
    });
    const other = posted.find((result) => result.requestId === "ctxv_other_agent_request_01");
    // Answered while the first Agent's upload was still held, and long before the deadline.
    expect(other).toMatchObject({ status: "failed", reason: "not_found" });
    expect(
      records.find(
        (record) =>
          record.properties.event === "context_view:result" &&
          record.properties.request_id === "ctxv_other_agent_request_01",
      )?.properties,
    ).toMatchObject({ queued_ms: 0 });
  } finally {
    Date.now = originalNow;
  }
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
