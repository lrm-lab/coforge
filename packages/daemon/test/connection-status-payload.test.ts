import { expect, test } from "bun:test";
import { encodeDaemonConnectionStatus } from "#src/connection/connection-status-payload";

test("Computer status heartbeat carries only scope and daemon worker identity", () => {
  const payload = JSON.parse(
    new TextDecoder().decode(
      encodeDaemonConnectionStatus({
        workspaceId: "workspace-1",
        computerId: "computer-1",
        workerInstanceId: "worker-1",
        startedAt: 10,
        serverHttpUrl: "https://private.example",
      }),
    ),
  );
  expect(payload).toEqual({
    workspaceId: "workspace-1",
    computerId: "computer-1",
    workerInstanceId: "worker-1",
    startedAt: 10,
    online: true,
  });
});
