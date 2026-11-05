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

/** A `connect` fake for a Daemon that is not running when first asked and answers afterwards: the
 * host's "is one already running?" probe finds nothing, and the wait after the start succeeds. */
export function risingConnect(serverUrl: string) {
  const accept = acceptingConnect(serverUrl);
  let asked = 0;
  return async () => {
    if (asked++ === 0) throw Object.assign(new Error("not running"), { code: "ENOENT" });
    return accept();
  };
}
