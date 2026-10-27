import {
  decodeDaemonHandshakeRequest,
  decodeLocalRpcRequest,
  encodeDaemonHandshakeResponse,
  encodeLocalRpcResponse,
  LOCAL_RPC_METHODS,
  readLocalRpcFrame,
} from "@lrm/coforge-sdk/internal";

/** A `connect` fake whose handshake always succeeds, so a daemon host can complete its local
 * socket wait without a real Unix socket. */
export function acceptingConnect(serverUrl: string) {
  return async () => ({
    request: async (frame: Uint8Array) => {
      const envelope = decodeLocalRpcRequest(readLocalRpcFrame(frame)!);
      const request = decodeDaemonHandshakeRequest(envelope.payload);
      return encodeLocalRpcResponse({
        method: LOCAL_RPC_METHODS.HANDSHAKE,
        payload: encodeDaemonHandshakeResponse({
          protocolMajor: 1,
          requestId: request.requestId,
          daemonId: "daemon-1",
          accepted: true,
          serverUrl,
        }),
      });
    },
    close() {},
  });
}
