import { expect, test } from "bun:test";
import { defaultCentrifugeWorkspaceClientFactory } from "#src/connection/centrifuge-workspace-client";
import { reportAgentSessionWithRetry } from "#src/connection/agent-session-report";

test.each([
  { wireCode: 1403, code: 403, category: "session_mismatch" },
  { wireCode: 1404, code: 403, category: "scope_unauthorized" },
  { wireCode: 1409, code: 409, category: "superseded" },
])(
  "protobuf RPC rejection $wireCode restores category independently of its wording",
  async ({ wireCode, code, category }) => {
    const text = [...new TextEncoder().encode("wording changed")];
    const error = [8, (wireCode & 127) | 128, wireCode >>> 7, 18, text.length, ...text];
    const server = Bun.serve<{ commands: number }>({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, server) {
        if (server.upgrade(request, { data: { commands: 0 } })) return;
        return new Response("upgrade required", { status: 400 });
      },
      websocket: {
        message(socket) {
          const payload =
            socket.data.commands++ === 0
              ? [8, 1, 42, 3, 10, 1, 99]
              : [8, 2, 18, error.length, ...error];
          socket.send(Uint8Array.from([payload.length, ...payload]));
        },
      },
    });
    const client = defaultCentrifugeWorkspaceClientFactory(`ws://127.0.0.1:${server.port}`, {});
    const connected = Promise.withResolvers<void>();
    client.on("connected", () => connected.resolve());
    client.on("error", ({ error }) => connected.reject(error));
    client.on("disconnected", () => connected.reject(new Error("connection closed")));
    try {
      client.connect();
      await connected.promise;
      await expect(
        reportAgentSessionWithRetry(
          {
            observeLaunch() {},
            rpc: async (method, bytes) => {
              await client.rpc(method, bytes);
            },
          },
          {
            protocolMajor: 1,
            requestId: "request",
            workspaceId: "w",
            computerId: "c",
            agentId: "a",
            provider: "pi",
            sessionId: "native",
            startRequestId: "start",
            daemonInstanceId: "daemon",
            launchId: "launch",
          },
        ),
      ).rejects.toMatchObject({ code, category, message: "wording changed" });
    } finally {
      client.disconnect();
      await server.stop(true);
    }
  },
);
