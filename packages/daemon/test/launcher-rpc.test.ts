import { expect, test } from "bun:test";
import {
  decodeDaemonCommandRequest,
  decodeDaemonHandshakeRequest,
  decodeDaemonHoldRequest,
  decodeLocalRpcRequest,
  encodeDaemonCommandResponse,
  encodeDaemonHandshakeResponse,
  encodeDaemonHoldResponse,
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

const connectionOperations = [
  {
    name: "control",
    method: "daemon:snapshot",
    invoke: (launcher: LocalDaemonLauncher) => launcher.control("snapshot"),
    respond: (payload: Uint8Array) =>
      encodeDaemonCommandResponse({
        protocolMajor: 1,
        requestId: decodeDaemonCommandRequest(payload).requestId,
        accepted: true,
        runtimes: [],
      }),
    expected: [],
  },
  {
    name: "hold",
    method: LOCAL_RPC_METHODS.HOLD,
    invoke: (launcher: LocalDaemonLauncher) => launcher.hold(),
    respond: (payload: Uint8Array) =>
      encodeDaemonHoldResponse({
        protocolMajor: 1,
        requestId: decodeDaemonHoldRequest(payload).requestId,
        accepted: true,
        held: true,
        busyAgents: [],
        unreachableWorkspaceIds: [],
      }),
    expected: { held: true, busyAgents: [] },
  },
  {
    name: "identity",
    method: LOCAL_RPC_METHODS.HANDSHAKE,
    invoke: (launcher: LocalDaemonLauncher) => launcher.identity(1234),
    respond: (payload: Uint8Array) =>
      encodeDaemonHandshakeResponse({
        protocolMajor: 1,
        requestId: decodeDaemonHandshakeRequest(payload).requestId,
        accepted: true,
        daemonId: "fixture-daemon",
        serverUrl: "https://coforge.test",
      }),
    expected: { daemonId: "fixture-daemon" },
  },
];

test.each(connectionOperations)(
  "$name keeps its connection open until the response settles, then closes on success or failure",
  async ({ method, invoke, respond, expected }) => {
    for (const fails of [false, true]) {
      const started = Promise.withResolvers<void>();
      const response = Promise.withResolvers<void>();
      const failure = new Error("transport disconnected");
      let closed = 0;
      const launcher = new LocalDaemonLauncher({
        executablePath: "/unused",
        socketPath: "/unused.sock",
        serverUrl: "https://coforge.test",
        connect: async () => ({
          async request(frame) {
            const request = decodeLocalRpcRequest(readLocalRpcFrame(frame)!);
            if (request.method === method) {
              started.resolve();
              await response.promise;
              return encodeLocalRpcResponse({ method, payload: respond(request.payload) });
            }
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
        }),
      });
      const result = invoke(launcher);
      try {
        await started.promise;
        expect(closed).toBe(0);
        if (fails) {
          response.reject(failure);
          await expect(result).rejects.toBe(failure);
        } else {
          response.resolve();
          expect(await result).toMatchObject(expected);
        }
        expect(closed).toBe(1);
      } finally {
        response.resolve();
        await result.catch(() => {});
      }
    }
  },
);
