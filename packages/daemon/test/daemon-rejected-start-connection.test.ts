import { expect, test } from "bun:test";
import { DaemonConnection } from "#src/connection/daemon-connection";
import { RuntimePublicationSubscriptions } from "#src/daemon-runtime/runtime-publication-subscriptions";
import { encodeAgentStartIntent, type AgentControlScope } from "@lrm/coforge-sdk/internal";
import { gatedCentrifuge } from "./fixtures/gated-centrifuge";
import { captureDaemonLogs } from "./log-capture";

const workspaceId = "019b0381-1111-7111-8111-111111111111";
const computerId = "019b0381-2222-7222-8222-222222222222";
const agentId = "019b0381-3333-7333-8333-333333333333";

const start = encodeAgentStartIntent({
  protocolMajor: 1,
  requestId: "start-9",
  workspaceId,
  computerId,
  agentId,
  provider: "pi",
  model: "default",
  reasoning: "balanced",
  controlEpoch: 4,
  launchId: "launch-9",
});

const retiredField = new Uint8Array([0xa8, 0x01, 0x01]);
const refused = new Uint8Array([...start, ...retiredField]);

async function harness() {
  const centrifuge = gatedCentrifuge(workspaceId, computerId);
  const transport = new DaemonConnection("wss://cloud.example", () => centrifuge.client);
  await transport.start("secret", { workspaceId, computerId });
  const started: string[] = [];
  const rejected: AgentControlScope[] = [];
  const subscriptions = new RuntimePublicationSubscriptions({
    transport,
    workspaceId,
    computerId,
    startAgent: async (intent: { requestId: string }) => void started.push(intent.requestId),
    rejectedAgentStart: async (scope: AgentControlScope) => void rejected.push(scope),
  } as unknown as ConstructorParameters<typeof RuntimePublicationSubscriptions>[0]);
  await subscriptions.install();
  return { centrifuge, started, rejected };
}

test("a Start refused as a whole but still naming its operation reaches the runtime once, and never starts", async () => {
  const { centrifuge, started, rejected } = await harness();
  await captureDaemonLogs(async () => {
    centrifuge.publish(refused);
  });
  await Bun.sleep(0);
  expect(started).toEqual([]);
  expect(rejected).toMatchObject([{ requestId: "start-9", epoch: 4, agentId }]);
});

test("a publication that names no operation is only logged, and a good Start is not reported as refused", async () => {
  const { centrifuge, rejected } = await harness();
  await captureDaemonLogs(async () => {
    centrifuge.publish(new Uint8Array([0x0a, 0x28, 0x61, 0x62, 0x63]));
    centrifuge.publish(start);
  });
  await Bun.sleep(0);
  expect(rejected).toEqual([]);
});
