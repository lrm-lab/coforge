import { afterEach, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeDaemonRuntimeConfigureResponse,
  decodeLocalRpcResponse,
  encodeDaemonRuntimeConfigureRequest,
  encodeLocalRpcRequest,
  frameLocalRpc,
  LOCAL_RPC_METHODS,
  MAX_LOCAL_RPC_FRAME_BYTES,
  readLocalRpcFrame,
} from "@lrm/coforge-sdk/internal";
import { DaemonCommandRejectedError, LocalDaemonLauncher } from "#src/daemon-host/launcher";
import { startDaemonLocalRpcServer } from "#src/local-rpc";
import { InMemoryDaemonCredentialStore } from "#src/credentials/credential-store";
import type { DaemonConfig } from "#src/daemon-runtime/runtime";
import { captureDaemonLogs } from "./log-capture";

const servers: Array<{ close(): Promise<void> }> = [];
const serverUrl = "https://coforge.test";

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function sendBytesAndAwaitClose(
  socketPath: string,
  chunks: readonly Uint8Array[],
): Promise<void> {
  const closed = Promise.withResolvers<void>();
  let chunkIndex = 0;
  let offset = 0;
  const flush = (socket: Bun.Socket<undefined>) => {
    while (chunkIndex < chunks.length) {
      const current = chunks[chunkIndex]!;
      const written = socket.write(current.subarray(offset));
      if (written === 0) return;
      offset += written;
      if (offset < current.byteLength) return;
      chunkIndex += 1;
      offset = 0;
    }
  };
  await Bun.connect({
    unix: socketPath,
    socket: {
      open(socket) {
        flush(socket);
      },
      drain(socket) {
        flush(socket);
      },
      data() {
        closed.reject(new Error("daemon unexpectedly answered an oversized frame"));
      },
      close() {
        closed.resolve();
      },
      error(_socket, error) {
        if (chunkIndex > 0 || offset > 0) return;
        closed.reject(error);
      },
    },
  });
  await closed.promise;
}

test("local RPC closes immediately and logs frame_too_large on a 4-byte oversized header", async () => {
  const socketPath = join(tmpdir(), `coforge-${crypto.randomUUID()}.sock`);
  const { records } = await captureDaemonLogs(async () => {
    const server = await startDaemonLocalRpcServer({
      socketPath,
      serverUrl,
      validateCredential: () => true,
      runtime: {},
      credentials: new InMemoryDaemonCredentialStore(),
    });
    servers.push(server);

    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, MAX_LOCAL_RPC_FRAME_BYTES + 1);
    await sendBytesAndAwaitClose(socketPath, [header.subarray(0, 2), header.subarray(2)]);

    // A healthy client can still handshake on a fresh connection afterwards.
    const launcher = new LocalDaemonLauncher({
      stateDirectory: tmpdir(),
      serverUrl,
      executablePath: "/unused",
      socketPath,
    });
    expect((await launcher.identity()).accepted).toBe(true);
  });

  expect(
    records.some((record) => record.properties.event === "daemon.local_rpc.frame_too_large"),
  ).toBe(true);
});

test("local RPC rejects buffer growth past the frame cap without unbounded allocation", async () => {
  const socketPath = join(tmpdir(), `coforge-${crypto.randomUUID()}.sock`);
  const { records } = await captureDaemonLogs(async () => {
    const server = await startDaemonLocalRpcServer({
      socketPath,
      serverUrl,
      validateCredential: () => true,
      runtime: {},
      credentials: new InMemoryDaemonCredentialStore(),
    });
    servers.push(server);

    // Valid header claiming MAX_LOCAL_RPC_FRAME_BYTES, followed by extra bytes pushing the
    // unconsumed socket buffer past 4 + MAX_LOCAL_RPC_FRAME_BYTES.
    const oversizedChunk = new Uint8Array(4 + MAX_LOCAL_RPC_FRAME_BYTES + 64);
    new DataView(oversizedChunk.buffer).setUint32(0, MAX_LOCAL_RPC_FRAME_BYTES);
    await sendBytesAndAwaitClose(socketPath, [oversizedChunk]);
  });

  expect(
    records.some((record) => record.properties.event === "daemon.local_rpc.frame_too_large"),
  ).toBe(true);
});

test("configure refusal rolls back credentials and config before answering with structured error and errorCode", async () => {
  const socketPath = join(tmpdir(), `coforge-${crypto.randomUUID()}.sock`);
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save("workspace-a", "computer-a", "previous-secret");
  let persistedConfig: DaemonConfig | null = {
    workspaceId: "workspace-prev",
    computerId: "computer-prev",
    workspaceRoot: "/workspaces/prev",
    serverHttpUrl: serverUrl,
  };

  const { records } = await captureDaemonLogs(async () => {
    const server = await startDaemonLocalRpcServer({
      socketPath,
      serverUrl,
      validateCredential: (token) => token !== "rejected-secret",
      runtime: {
        configure: async () => {
          throw Object.assign(new Error("systemd user service failed to start"), {
            code: "service_start_failed",
          });
        },
      },
      credentials,
      configStore: {
        load: async () => persistedConfig,
        save: async (next) => {
          persistedConfig = next;
        },
        clear: async () => {
          persistedConfig = null;
        },
      },
    });
    servers.push(server);

    const launcher = new LocalDaemonLauncher({
      stateDirectory: tmpdir(),
      serverUrl,
      executablePath: "/unused",
      socketPath,
      timeoutMilliseconds: 0,
    });

    const runtimeError = await launcher
      .ensureStarted({
        workspaceId: "workspace-a",
        computerId: "computer-a",
        workspaceRoot: "/workspaces/workspace-a",
        daemonApiKey: "rotated-secret",
      })
      .catch((reason: unknown) => reason);

    expect(runtimeError).toBeInstanceOf(DaemonCommandRejectedError);
    expect(runtimeError).toMatchObject({
      operation: "configure",
      code: "service_start_failed",
      workspaceId: "workspace-a",
    });
    expect((runtimeError as Error).message).toContain("systemd user service failed to start");
    expect(await credentials.load("workspace-a", "computer-a")).toBe("previous-secret");
    expect(persistedConfig?.workspaceId).toBe("workspace-prev");

    const mismatchError = await launcher
      .ensureStarted({
        workspaceId: "workspace-a",
        computerId: "computer-a",
        workspaceRoot: "/workspaces/workspace-a",
        daemonApiKey: "rotated-secret",
        serverHttpUrl: "https://other.coforge.example",
      })
      .catch((reason: unknown) => reason);

    expect(mismatchError).toBeInstanceOf(DaemonCommandRejectedError);
    expect(mismatchError).toMatchObject({
      operation: "configure",
      code: "server_mismatch",
    });
    expect((mismatchError as Error).message).toContain("server does not match");

    // Verify wire-level configure refusal response on invalid credential without closing socket first.
    const responseBytes = await new Promise<Uint8Array>((resolve, reject) => {
      let buffer = new Uint8Array();
      void Bun.connect({
        unix: socketPath,
        socket: {
          open(socket) {
            socket.write(
              frameLocalRpc(
                encodeLocalRpcRequest({
                  method: LOCAL_RPC_METHODS.CONFIGURE,
                  payload: encodeDaemonRuntimeConfigureRequest({
                    protocolMajor: 1,
                    requestId: "req-cred",
                    workspaceId: "workspace-a",
                    computerId: "computer-a",
                    workspaceRoot: "/workspaces/workspace-a",
                    daemonApiKey: "rejected-secret",
                    expectedServerUrl: serverUrl,
                  }),
                }),
              ),
            );
          },
          data(socket, chunk) {
            const next = new Uint8Array(buffer.byteLength + chunk.byteLength);
            next.set(buffer);
            next.set(chunk, buffer.byteLength);
            buffer = next;
            const frame = readLocalRpcFrame(buffer);
            if (!frame) return;
            socket.end();
            resolve(frame);
          },
          error(_socket, error) {
            reject(error);
          },
          end() {
            reject(new Error("local daemon socket closed"));
          },
        },
      });
    });

    const decoded = decodeDaemonRuntimeConfigureResponse(
      decodeLocalRpcResponse(responseBytes).payload,
    );
    expect(decoded).toEqual({
      protocolMajor: 1,
      requestId: "req-cred",
      accepted: false,
      error: "daemon credential was rejected",
      errorCode: "invalid_credential",
    });
  });

  expect(
    records.some((record) => record.properties.event === "daemon.local_rpc.configure_refused"),
  ).toBe(true);
});
