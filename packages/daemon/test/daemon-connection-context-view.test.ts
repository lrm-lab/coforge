import { expect, spyOn, test } from "bun:test";
import { DaemonConnection } from "#src/connection/daemon-connection";
import { fakeClient, config } from "./daemon-connection.test";
import type { AgentContextViewResult } from "@lrm/coforge-sdk/internal";

const TEST_AGENT_API_KEY = `sk_agent_${"a".repeat(43)}`;

test("context view result upload sends both daemon and Agent-scoped credentials", async () => {
  const calls: Request[] = [];
  spyOn(globalThis, "fetch").mockImplementation((async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    calls.push(new Request(input as string, init));
    return new Response(null, { status: 204 });
  }) as typeof fetch);
  const transport = new DaemonConnection("wss://cloud.example", () => fakeClient().client);
  await transport.start("daemon-token", {
    ...config,
    serverHttpUrl: "https://server.example",
  });
  const result: AgentContextViewResult = {
    protocolMajor: 1,
    requestId: "ctxv_1234567890123456",
    workspaceId: config.workspaceId,
    computerId: config.computerId,
    agentId: "agent-1",
    messageId: "message-1",
    sessionId: "session-1",
    maxBytes: 1024,
    status: "ok",
    createdAtMs: 1,
    content: new TextEncoder().encode("{}"),
    encoding: "identity",
  };
  await transport.postAgentContextViewResult(result, TEST_AGENT_API_KEY);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.headers.get("authorization")).toBe("Bearer daemon-token");
  expect(calls[0]?.headers.get("x-coforge-agent-api-key")).toBe(`Bearer ${TEST_AGENT_API_KEY}`);
  expect(calls[0]?.headers.get("content-encoding")).toBe("gzip");
});
