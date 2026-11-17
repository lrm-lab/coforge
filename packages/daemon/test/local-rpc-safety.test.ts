import { afterEach, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_LOCAL_RPC_FRAME_BYTES } from "@lrm/coforge-sdk/internal";
import { LocalDaemonLauncher } from "#src/daemon-host/launcher";
import { startDaemonLocalRpcServer } from "#src/local-rpc";
import { InMemoryDaemonCredentialStore } from "#src/credentials/credential-store";
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
