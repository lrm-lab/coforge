import { expect, test } from "bun:test";
import { encodeAgentSessionReport } from "@lrm/coforge-sdk/internal";
import { createAgentSessionMethod } from "#src/server/centrifugo/agent-session-receiver.server";
import { AgentSessionVerifyError } from "#src/server/agents/agent-sessions.server";

test.each([
  { field: "sessionId" as const, legacy: 403, current: 1403 },
  { field: "launchId" as const, legacy: 409, current: 1409 },
  { field: undefined, legacy: 403, current: 1404 },
])(
  "session rejection $field keeps legacy codes unless this worker supports new ones",
  async ({ field, legacy, current }) => {
    const payload = encodeAgentSessionReport({
      protocolMajor: 1,
      requestId: "request",
      workspaceId: "w",
      computerId: "c",
      agentId: "a",
      provider: "pi",
      sessionId: "native",
      startRequestId: "start",
      daemonInstanceId: "worker",
      launchId: "launch",
    });
    let supported = false;
    const method = createAgentSessionMethod(
      {
        accept: async () => {
          if (field) throw new AgentSessionVerifyError(field);
          throw new Error("Stale Agent scope");
        },
        verify: async () => {
          throw new Error("not used");
        },
      },
      undefined,
      {
        supports: async (workspaceId, computerId, workerInstanceId) => {
          expect([workspaceId, computerId, workerInstanceId]).toEqual(["w", "c", "worker"]);
          return supported;
        },
      },
    );
    const metadata = { principal: { userId: "owner", workspaceId: "w", computerId: "c" } };
    expect(await method(payload, metadata)).toMatchObject({ code: legacy });
    supported = true;
    expect(await method(payload, metadata)).toMatchObject({ code: current });
  },
);
