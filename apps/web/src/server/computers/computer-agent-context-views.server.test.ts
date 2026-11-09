import { expect, test } from "bun:test";
import { ComputerAgentContextViews } from "./computer-agent-context-views.server";

test("waits up to the Raft viewer window and rejects mismatched result scope", async () => {
  let published = false;
  let sentRequestId = "";
  const request = {
    computerId: "computer-1",
    agentId: "agent-1",
    messageId: "message-1",
    sessionId: "session-1",
    maxBytes: 1024,
  };
  const service = new ComputerAgentContextViews(
    {
      owned: async () => true,
      online: async () => true,
      supported: async () => true,
      publish: async (request) => {
        published = true;
        sentRequestId = request.requestId;
      },
      results: {
        begin: async () => {},
        read: async () => ({
          protocolMajor: 1,
          requestId: sentRequestId,
          workspaceId: "workspace-1",
          ...request,
          status: "ok" as const,
          createdAtMs: 1,
          content: new TextEncoder().encode("x"),
          encoding: "identity" as const,
        }),
        clear: async () => {},
      },
    },
    { now: () => 0, wait: async () => {}, timeoutMs: 30_000 },
  );
  const result = await service.view({ userId: "user-1", workspaceId: "workspace-1" }, request);
  expect(published).toBe(true);
  expect(result.status).toBe("ready");
});

test("feature gate prevents publishing", async () => {
  let published = false;
  const service = new ComputerAgentContextViews({
    enabled: async () => false,
    owned: async () => true,
    online: async () => true,
    supported: async () => true,
    publish: async () => {
      published = true;
    },
    results: { begin: async () => {}, read: async () => undefined, clear: async () => {} },
  });
  const result = await service.view(
    { userId: "u", workspaceId: "w" },
    { computerId: "c", agentId: "a", messageId: "m", sessionId: "s", maxBytes: 1 },
  );
  expect(result).toEqual({ status: "unsupported" });
  expect(published).toBe(false);
});

test("normalizes a gzip result before exposing it to the viewer", async () => {
  let sentRequestId = "";
  const request = {
    computerId: "c",
    agentId: "a",
    messageId: "m",
    sessionId: "s",
    maxBytes: 1024,
  };
  const service = new ComputerAgentContextViews(
    {
      owned: async () => true,
      online: async () => true,
      supported: async () => true,
      publish: async (value) => {
        sentRequestId = value.requestId;
      },
      results: {
        begin: async () => {},
        read: async () => ({
          protocolMajor: 1,
          requestId: sentRequestId,
          workspaceId: "w",
          ...request,
          status: "ok" as const,
          createdAtMs: 1,
          content: new Uint8Array(Bun.gzipSync(Buffer.from("context"))),
          encoding: "gzip" as const,
        }),
        clear: async () => {},
      },
    },
    { now: () => 0, wait: async () => {}, timeoutMs: 1 },
  );
  const result = await service.view({ userId: "u", workspaceId: "w" }, request);
  expect(result.status).toBe("ready");
  if (result.status === "ready") {
    expect(result.result.encoding).toBe("identity");
    expect(new TextDecoder().decode(result.result.content)).toBe("context");
  }
});

test("owner check rejects before contacting the Computer", async () => {
  let published = false;
  const service = new ComputerAgentContextViews({
    owned: async () => false,
    online: async () => true,
    supported: async () => true,
    publish: async () => {
      published = true;
    },
    results: { begin: async () => {}, read: async () => undefined, clear: async () => {} },
  });
  const result = await service.view(
    { userId: "attacker", workspaceId: "w" },
    { computerId: "c", agentId: "a", messageId: "m", sessionId: "s", maxBytes: 1 },
  );
  expect(result).toEqual({ status: "unavailable" });
  expect(published).toBe(false);
});
