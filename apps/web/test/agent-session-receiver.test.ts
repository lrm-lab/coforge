import { expect, test } from "bun:test";
import { encodeAgentSessionReport, encodeAgentSessionInvalidate } from "@lrm/coforge-sdk/internal";
import {
  createAgentSessionMethod,
  createAgentSessionInvalidateMethod,
} from "#src/server/centrifugo/agent-session-receiver.server";
import {
  AgentSessionVerifyError,
  type AgentSessions,
} from "#src/server/agents/agent-sessions.server";
import type { AgentSessionReceiver } from "#src/server/agents/agent-session.server";
import type { CentrifugoRpcMetadata } from "#src/server/centrifugo/rpc-handler.server";

function captureWarnings() {
  const warnings: unknown[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(JSON.parse(args[0] as string));
  return {
    warnings,
    restore: () => {
      console.warn = original;
    },
  };
}

const metadata: CentrifugoRpcMetadata = {
  principal: { userId: "daemon", workspaceId: "w", computerId: "c" },
};

const payload = encodeAgentSessionReport({
  protocolMajor: 1,
  requestId: "request-a",
  workspaceId: "w",
  computerId: "c",
  agentId: "agent-a",
  provider: "pi",
  sessionId: "native-a",
  startRequestId: "start-a",
  daemonInstanceId: "daemon-a",
  launchId: "launch-a",
});

test("a rejected Session snapshot with non-verify error logs a warning and returns 503", async () => {
  const sessions: Pick<AgentSessions, "accept" | "verify"> = {
    accept: async () => {
      throw new Error("database connection failed");
    },
    verify: async () => {
      throw new Error("must not be reached: accept() calls verify() itself when needed");
    },
  };
  const method = createAgentSessionMethod(sessions, undefined);
  const capture = captureWarnings();
  let response;
  try {
    response = await method(payload, metadata);
  } finally {
    capture.restore();
  }
  expect(response).toEqual({ code: 503, message: "Agent session could not be accepted" });
  expect(capture.warnings).toEqual([
    expect.objectContaining({
      event: "agent_session:snapshot_rejected",
      agent_id: "agent-a",
      workspace_id: "w",
      computer_id: "c",
      reason: "unexpected: Error",
    }),
  ]);
});

test("a successful snapshot is never logged", async () => {
  const sessions: Pick<AgentSessions, "accept" | "verify"> = {
    accept: async () => {},
    verify: async () => ({
      provider: "pi",
      computerId: "c",
      startRequestId: "start-a",
      daemonInstanceId: "daemon-a",
    }),
  };
  const method = createAgentSessionMethod(sessions, undefined);
  const capture = captureWarnings();
  let response;
  try {
    response = await method(payload, metadata);
  } finally {
    capture.restore();
  }
  expect(response).toEqual(new Uint8Array());
  expect(capture.warnings).toEqual([]);
});

const invalidatePayload = encodeAgentSessionInvalidate({
  protocolMajor: 1,
  requestId: "invalidate-a",
  workspaceId: "w",
  computerId: "c",
  agentId: "agent-a",
  provider: "pi",
  sessionId: "stale-a",
  daemonInstanceId: "daemon-a",
  launchId: "launch-a",
  reason: "missing",
});

test("an idempotent no-op invalidate is never logged", async () => {
  const receiver: Pick<AgentSessionReceiver, "invalidate"> = {
    invalidate: async () => {},
  };
  const method = createAgentSessionInvalidateMethod(receiver);
  const capture = captureWarnings();
  let response;
  try {
    response = await method(invalidatePayload, metadata);
  } finally {
    capture.restore();
  }
  expect(response).toEqual(new Uint8Array());
  expect(capture.warnings).toEqual([]);
});

test("a genuine invalidate failure (propagated, not swallowed) logs with request_id and stays a bare 403", async () => {
  const receiver: Pick<AgentSessionReceiver, "invalidate"> = {
    invalidate: async () => {
      throw new Error("database unavailable");
    },
  };
  const method = createAgentSessionInvalidateMethod(receiver);
  const capture = captureWarnings();
  let response;
  try {
    response = await method(invalidatePayload, metadata);
  } finally {
    capture.restore();
  }
  expect(response).toEqual({ code: 403, message: "Agent Session invalidate is not authorized" });
  expect(capture.warnings).toEqual([
    expect.objectContaining({
      event: "agent_session:invalidate_rejected",
      request_id: "invalidate-a",
      agent_id: "agent-a",
      workspace_id: "w",
      computer_id: "c",
      launch_id: "launch-a",
      reason: "unexpected: Error",
    }),
  ]);
});

test("a verify rejection logs the field that diverged, still with the stable reason and category", async () => {
  const sessions: Pick<AgentSessions, "accept" | "verify"> = {
    accept: async () => {
      // The real `accept` verifies first; this is the error that reaches the handler.
      throw new AgentSessionVerifyError("sessionId");
    },
    verify: async () => {
      throw new Error("must not be reached without a snapshot");
    },
  };
  const method = createAgentSessionMethod(sessions, undefined);
  const capture = captureWarnings();
  let response;
  try {
    response = await method(payload, metadata);
  } finally {
    capture.restore();
  }
  expect(response).toEqual({
    code: 403,
    message: "Agent Session snapshot is not authorized",
    category: "session_mismatch",
  });
  expect(capture.warnings).toEqual([
    expect.objectContaining({
      event: "agent_session:snapshot_rejected",
      category: "session_mismatch",
      reason: "Agent session report is stale or unauthorized",
      field: "sessionId",
    }),
  ]);
});

test("a launchId verify rejection returns superseded", async () => {
  const sessions: Pick<AgentSessions, "accept" | "verify"> = {
    accept: async () => {
      throw new AgentSessionVerifyError("launchId");
    },
    verify: async () => {
      throw new Error("must not be reached without a snapshot");
    },
  };
  const method = createAgentSessionMethod(sessions, undefined);
  const capture = captureWarnings();
  let response;
  try {
    response = await method(payload, metadata);
  } finally {
    capture.restore();
  }
  expect(response).toEqual({
    code: 409,
    message: "Agent session launch was superseded",
    category: "superseded",
  });
  expect(capture.warnings).toEqual([
    expect.objectContaining({
      event: "agent_session:snapshot_rejected",
      category: "superseded",
      reason: "Agent session report is stale or unauthorized",
      field: "launchId",
    }),
  ]);
});
