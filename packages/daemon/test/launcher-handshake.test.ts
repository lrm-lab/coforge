import { expect, test } from "bun:test";
import {
  decodeDaemonHandshakeRequest,
  decodeLocalRpcRequest,
  encodeDaemonHandshakeResponse,
  encodeLocalRpcResponse,
  LOCAL_RPC_METHODS,
  readLocalRpcFrame,
  type DaemonHandshakeResponse,
} from "@lrm/coforge-sdk/internal";
import { LocalDaemonLauncher } from "#src/daemon-host/launcher";

function handshakeFixture(
  response: Partial<DaemonHandshakeResponse> = {},
  method: string = LOCAL_RPC_METHODS.HANDSHAKE,
) {
  let closed = 0;
  const timeouts: Array<number | undefined> = [];
  const launcher = new LocalDaemonLauncher({
    executablePath: "/unused",
    socketPath: "/unused.sock",
    serverUrl: "https://coforge.test",
    connect: async () => ({
      async request(frame, timeoutMs) {
        timeouts.push(timeoutMs);
        const request = decodeLocalRpcRequest(readLocalRpcFrame(frame)!);
        expect(request.method).toBe(LOCAL_RPC_METHODS.HANDSHAKE);
        const handshake = decodeDaemonHandshakeRequest(request.payload);
        expect(handshake.protocolMajor).toBe(1);
        expect(handshake.requestId).toMatch(/^[0-9a-f-]{36}$/);
        return encodeLocalRpcResponse({
          method,
          payload: encodeDaemonHandshakeResponse({
            protocolMajor: 1,
            requestId: handshake.requestId,
            accepted: true,
            daemonId: "test-daemon",
            serverUrl: "https://coforge.test/path",
            ...response,
          }),
        });
      },
      close() {
        closed++;
      },
    }),
  });
  return { launcher, timeouts, closed: () => closed };
}

test("identity returns handshake details, forwards its deadline, and closes the connection", async () => {
  const fixture = handshakeFixture({ cloudConnection: "connected", processId: 123 });
  expect(await fixture.launcher.identity(1234)).toMatchObject({
    cloudConnection: "connected",
    processId: 123,
    serverUrl: "https://coforge.test/path",
  });
  expect(fixture.timeouts).toEqual([1234]);
  expect(fixture.closed()).toBe(1);
});

test("ensureRunning uses the default request deadline and closes the connection", async () => {
  const fixture = handshakeFixture();
  await fixture.launcher.ensureRunning();
  expect(fixture.timeouts).toEqual([undefined]);
  expect(fixture.closed()).toBe(1);
});

test.each([
  { name: "protocol", response: { protocolMajor: 2 } },
  { name: "request ID", response: { requestId: "different" } },
  { name: "refusal", response: { accepted: false } },
  { name: "missing server", response: { serverUrl: "" } },
  { name: "server origin", response: { serverUrl: "https://other.test" } },
])("invalid $name keeps each caller's error and closes its connection", async ({ response }) => {
  const identity = handshakeFixture(response);
  await expect(identity.launcher.identity()).rejects.toThrow("invalid process identity");
  expect(identity.closed()).toBe(1);

  const control = handshakeFixture(response);
  await expect(control.launcher.control("snapshot")).rejects.toThrow(
    "coforge-daemon server does not match this Computer build",
  );
  expect(control.timeouts).toEqual([undefined]);
  expect(control.closed()).toBe(1);
});

test("wrong handshake method keeps each caller's distinct error", async () => {
  const identity = handshakeFixture({}, "daemon:wrong");
  await expect(identity.launcher.identity()).rejects.toThrow("invalid process identity");
  expect(identity.closed()).toBe(1);

  const control = handshakeFixture({}, "daemon:wrong");
  await expect(control.launcher.control("snapshot")).rejects.toThrow(
    "coforge-daemon returned an invalid handshake",
  );
  expect(control.closed()).toBe(1);
});
