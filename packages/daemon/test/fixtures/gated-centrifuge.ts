import type { CentrifugeWorkspaceClient } from "#src/connection/centrifuge-workspace-client";
import {
  DAEMON_RUNTIME_READY_METHOD,
  type DaemonRuntimeReadyRequest,
} from "@lrm/coforge-sdk/internal";

/** A Centrifugo client whose ready RPC answers only when the test lets it, which is how an outage
 * looks from inside the daemon: the handshake stays pending while publications keep arriving. */
export function gatedCentrifuge(workspaceId: string, computerId: string) {
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

export const readyRequest = (
  workspaceId: string,
  computerId: string,
): DaemonRuntimeReadyRequest => ({
  protocolMajor: 1,
  requestId: crypto.randomUUID(),
  workspaceId,
  computerId,
  workerInstanceId: "runtime-1",
  startedAt: 123,
  runningAgentIds: [],
});
