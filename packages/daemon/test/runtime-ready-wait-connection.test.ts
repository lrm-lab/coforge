import { expect, test } from "bun:test";
import type { CentrifugeWorkspaceClient } from "#src/connection/centrifuge-workspace-client";
import { DaemonConnection } from "#src/connection/daemon-connection";
import { RuntimePublicationSubscriptions } from "#src/daemon-runtime/runtime-publication-subscriptions";
import {
  DAEMON_RUNTIME_READY_METHOD,
  encodeAgentStopIntent,
  type AgentStopIntent,
  type DaemonRuntimeReadyRequest,
} from "@lrm/coforge-sdk/internal";

const workspaceId = "workspace-a";
const computerId = "computer-a";

/** A Centrifugo client whose ready RPC answers only when the test lets it, which is how an outage
 * looks from inside the daemon: the handshake stays pending while publications keep arriving. */
function gatedCentrifuge() {
  let connected = () => {};
  let publication = (_event: { channel: string; data: Uint8Array }) => {};
  const answer = Promise.withResolvers<void>();
  const client: CentrifugeWorkspaceClient = {
    on(event, callback) {
      if (event === "connected") connected = callback as () => void;
      else if (event === "publication") publication = callback as typeof publication;
    },
    connect: () => connected(),
    disconnect() {},
    rpc: async (method) => {
      if (method === DAEMON_RUNTIME_READY_METHOD) await answer.promise;
      return new Uint8Array();
    },
  };
  return {
    client,
    answerReady: () => answer.resolve(),
    publish: (data: Uint8Array) =>
      publication({ channel: `daemon:${workspaceId}:${computerId}`, data }),
  };
}

const readyRequest = (): DaemonRuntimeReadyRequest => ({
  protocolMajor: 1,
  requestId: crypto.randomUUID(),
  workspaceId,
  computerId,
  workerInstanceId: "runtime-1",
  startedAt: 123,
  runningAgentIds: [],
});

/**
 * The daemon holds a pending ready's publications in two places, one after the other: the
 * connection holds them until the cloud accepts ready, then the runtime's own subscriptions buffer
 * them until the start releases. A count meant to describe a stuck start has to cover both, or it
 * reads zero for exactly as long as the publications queue up.
 */
test("a publication queued behind a pending ready is reported as held", async () => {
  const centrifuge = gatedCentrifuge();
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

  const ready = transport.ready(readyRequest);
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
