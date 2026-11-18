import { expect, test } from "bun:test";
import { DaemonConnection } from "#src/connection/daemon-connection";
import { gatedCentrifuge, readyRequest } from "./fixtures/gated-centrifuge";
import { RuntimePublicationSubscriptions } from "#src/daemon-runtime/runtime-publication-subscriptions";
import { encodeAgentStopIntent, type AgentStopIntent } from "@lrm/coforge-sdk/internal";

const workspaceId = "workspace-a";
const computerId = "computer-a";

/**
 * The daemon holds a pending ready's publications in two places, one after the other: the
 * connection holds them until the cloud accepts ready, then the runtime's own subscriptions buffer
 * them until the start releases. A count meant to describe a stuck start has to cover both, or it
 * reads zero for exactly as long as the publications queue up.
 */
test("a publication queued behind a pending ready is reported as held", async () => {
  const centrifuge = gatedCentrifuge(workspaceId, computerId);
  const transport = new DaemonConnection("wss://cloud.example", () => centrifuge.client);
  await transport.start("secret", { workspaceId, computerId });
  const delivered: string[] = [];
  const subscriptions = new RuntimePublicationSubscriptions({
    transport,
    workspaceId,
    computerId,
    stopAgent: async (intent: AgentStopIntent) => void delivered.push(intent.agentId),
  } as unknown as ConstructorParameters<typeof RuntimePublicationSubscriptions>[0]);
  await subscriptions.install();

  const ready = transport.ready(() => readyRequest(workspaceId, computerId));
  centrifuge.publish(
    encodeAgentStopIntent({
      protocolMajor: 1,
      requestId: "stop-1",
      workspaceId,
      computerId,
      agentId: "agent-a",
    }),
  );

  // The cloud has not accepted ready, so the runtime's own subscriber never saw the Stop.
  expect(subscriptions.heldCount()).toBe(1);
  expect(delivered).toEqual([]);

  // The cloud accepts ready: the connection hands the Stop over, and the runtime's own buffer takes
  // it from there, so the run the start flushes is what finally delivers it.
  centrifuge.answerReady();
  await ready;
  expect(subscriptions.heldCount()).toBe(1);
  expect(delivered).toEqual([]);
  for (const flush of subscriptions.release().buffered) await flush();
  expect(delivered).toEqual(["agent-a"]);
  expect(subscriptions.heldCount()).toBe(0);
  await transport.stop();
});
