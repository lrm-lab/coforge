import { expect, test } from "bun:test";
import { DaemonQueries } from "#src/connection/daemon-queries";
import { captureDaemonLogs } from "./log-capture";

test("invalid context-view request bytes emit the Raft invalid-request event", async () => {
  const queries = new DaemonQueries(async () => {});
  // The context-view decoder rejects this malformed protobuf payload. The receive path must
  // still classify the request as invalid instead of silently treating it as an unknown query.
  const { records } = await captureDaemonLogs(async () => {
    expect(
      queries.receive(new Uint8Array([0xff]), {
        workspaceId: "workspace-1",
        computerId: "computer-1",
      }),
    ).toBe(false);
  });
  expect(
    records.find(
      (record) => record.properties.event === "daemon.agent_context_view.request_invalid",
    ),
  ).toBeDefined();
});
