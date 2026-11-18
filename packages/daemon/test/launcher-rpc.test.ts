import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  decodeDaemonCommandRequest,
  decodeDaemonHandshakeRequest,
  decodeDaemonHoldRequest,
  decodeDaemonRuntimeConfigureRequest,
  decodeLocalRpcRequest,
  encodeDaemonCommandResponse,
  encodeDaemonHandshakeResponse,
  encodeDaemonHoldResponse,
  encodeDaemonRuntimeConfigureResponse,
  encodeLocalRpcResponse,
  LOCAL_RPC_METHODS,
  LocalRpcFrameTooLargeError,
  MAX_LOCAL_RPC_FRAME_BYTES,
  readLocalRpcFrame,
} from "@lrm/coforge-sdk/internal";
import { DaemonCommandRejectedError, LocalDaemonLauncher } from "#src/daemon-host/launcher";

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
      timeoutMilliseconds: 0,
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

test("connectToLocalDaemon rejects immediately when a peer sends an oversized frame header", async () => {
  const socketPath = join(tmpdir(), `coforge-oversized-${crypto.randomUUID()}.sock`);
  const listener = Bun.listen({
    unix: socketPath,
    socket: {
      data(socket) {
        const header = new Uint8Array(4);
        new DataView(header.buffer).setUint32(0, MAX_LOCAL_RPC_FRAME_BYTES + 1);
        socket.write(header);
      },
    },
  });
  try {
    const launcher = new LocalDaemonLauncher({
      executablePath: "/unused",
      socketPath,
      serverUrl: "https://coforge.test",
    });
    await expect(launcher.identity(1_000)).rejects.toBeInstanceOf(LocalRpcFrameTooLargeError);
  } finally {
    listener.stop(true);
    await rm(socketPath, { force: true });
  }
});

test("ensureStarted surfaces structured error and errorCode from a refused CONFIGURE response", async () => {
  const launcher = new LocalDaemonLauncher({
    executablePath: "/unused",
    socketPath: "/unused.sock",
    serverUrl: "https://coforge.test",
    connect: async () => ({
      async request(frame) {
        const envelope = decodeLocalRpcRequest(readLocalRpcFrame(frame)!);
        if (envelope.method === LOCAL_RPC_METHODS.HANDSHAKE) {
          const handshake = decodeDaemonHandshakeRequest(envelope.payload);
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
        }
        const configure = decodeDaemonRuntimeConfigureRequest(envelope.payload);
        return encodeLocalRpcResponse({
          method: LOCAL_RPC_METHODS.CONFIGURE,
          payload: encodeDaemonRuntimeConfigureResponse({
            protocolMajor: 1,
            requestId: configure.requestId,
            accepted: false,
            error: "Workspace workspace-1 is parked after credential revocation",
            errorCode: "credential_revoked",
          }),
        });
      },
      close() {},
    }),
  });

  const error = await launcher
    .ensureStarted({
      workspaceId: "workspace-1",
      computerId: "computer-1",
      workspaceRoot: "/workspace",
      daemonApiKey: "fixture-key",
    })
    .catch((reason: unknown) => reason);

  expect(error).toBeInstanceOf(DaemonCommandRejectedError);
  expect(error).toMatchObject({
    operation: "configure",
    code: "credential_revoked",
    workspaceId: "workspace-1",
  });
  expect((error as Error).message).toContain(
    "Workspace workspace-1 is parked after credential revocation",
  );
});

test("ensureStarted retries when CONFIGURE disconnects on a temporary failure", async () => {
  let configureAttempts = 0;
  const launcher = new LocalDaemonLauncher({
    executablePath: "/unused",
    socketPath: "/unused.sock",
    serverUrl: "https://coforge.test",
    timeoutMilliseconds: 2_000,
    sleep: async () => {},
    connect: async () => ({
      async request(frame) {
        const envelope = decodeLocalRpcRequest(readLocalRpcFrame(frame)!);
        if (envelope.method === LOCAL_RPC_METHODS.HANDSHAKE) {
          const handshake = decodeDaemonHandshakeRequest(envelope.payload);
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
        }
        configureAttempts += 1;
        if (configureAttempts === 1) {
          throw new Error("local daemon socket closed");
        }
        const configure = decodeDaemonRuntimeConfigureRequest(envelope.payload);
        return encodeLocalRpcResponse({
          method: LOCAL_RPC_METHODS.CONFIGURE,
          payload: encodeDaemonRuntimeConfigureResponse({
            protocolMajor: 1,
            requestId: configure.requestId,
            accepted: true,
          }),
        });
      },
      close() {},
    }),
  });

  await expect(
    launcher.ensureStarted({
      workspaceId: "workspace-1",
      computerId: "computer-1",
      workspaceRoot: "/workspace",
      daemonApiKey: "fixture-key",
    }),
  ).resolves.toEqual({});
  expect(configureAttempts).toBe(2);
});
