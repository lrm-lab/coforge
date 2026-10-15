import { expect, test } from "bun:test";
import {
  decodeDaemonHandshakeRequest,
  decodeLocalRpcRequest,
  encodeDaemonHandshakeResponse,
  encodeLocalRpcResponse,
  LOCAL_RPC_METHODS,
  readLocalRpcFrame,
} from "@lrm/coforge-sdk/internal";
import { LocalDaemonLauncher } from "#src/daemon-host/launcher";

const operations = [
  {
    name: "control",
    method: "daemon:snapshot",
    invoke: (launcher: LocalDaemonLauncher) => launcher.control("snapshot"),
  },
  {
    name: "hold",
    method: LOCAL_RPC_METHODS.HOLD,
    invoke: (launcher: LocalDaemonLauncher) => launcher.hold("hold", "restart"),
  },
  {
    name: "configure",
    method: LOCAL_RPC_METHODS.CONFIGURE,
    invoke: (launcher: LocalDaemonLauncher) =>
      launcher.ensureStarted({
        workspaceId: "workspace-1",
        computerId: "computer-1",
        workspaceRoot: "/workspace",
        daemonApiKey: "fixture-key",
      }),
  },
];

test.each(operations)(
  "$name retains its handshake sequence and closes the connection after a transport failure",
  async ({ name, method, invoke }) => {
    const failure = new Error("transport disconnected");
    const methods: string[] = [];
    let connections = 0;
    let closed = 0;
    const launcher = new LocalDaemonLauncher({
      executablePath: "/unused",
      socketPath: "/unused.sock",
      serverUrl: "https://coforge.test",
      connect: async () => {
        connections++;
        return {
          async request(frame) {
            const request = decodeLocalRpcRequest(readLocalRpcFrame(frame)!);
            methods.push(request.method);
            if (request.method !== LOCAL_RPC_METHODS.HANDSHAKE) throw failure;
            const handshake = decodeDaemonHandshakeRequest(request.payload);
            return encodeLocalRpcResponse({
              method: LOCAL_RPC_METHODS.HANDSHAKE,
              payload: encodeDaemonHandshakeResponse({
                protocolMajor: 1,
                requestId: handshake.requestId,
                accepted: true,
                daemonId: "fixture-daemon",
                serverUrl: "https://coforge.test",
              }),
            });
          },
          close() {
            closed++;
          },
        };
      },
    });
    const error = await invoke(launcher).catch((reason: unknown) => reason);
    if (name === "configure") {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("coforge-daemon did not accept the local handshake");
      expect((error as Error).cause).toBe(failure);
    } else {
      expect(error).toBe(failure);
    }
    expect(methods).toEqual(name === "hold" ? [method] : [LOCAL_RPC_METHODS.HANDSHAKE, method]);
    expect(connections).toBe(1);
    expect(closed).toBe(1);
  },
);
