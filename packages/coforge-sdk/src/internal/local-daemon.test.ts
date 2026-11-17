import { describe, expect, test } from "bun:test";
import {
  decodeMessageTask,
  decodeDaemonCommandResponse,
  decodeDaemonHandshakeRequest,
  decodeDaemonHandshakeResponse,
  decodeDaemonRuntimeConfigureRequest,
  decodeDaemonRuntimeConfigureResponse,
  encodeDaemonCommandResponse,
  encodeDaemonHandshakeRequest,
  encodeDaemonHandshakeResponse,
  encodeDaemonRuntimeConfigureRequest,
  encodeDaemonRuntimeConfigureResponse,
  frameLocalRpc,
  LocalRpcFrameTooLargeError,
  MAX_LOCAL_RPC_FRAME_BYTES,
  readLocalRpcFrame,
  readLocalRpcFrames,
} from "./local-daemon";

test("message metadata preserves a Backlog task", () => {
  expect(decodeMessageTask({ number: 12, status: "backlog" })).toEqual({
    number: 12,
    status: "backlog",
  });
});

describe("local daemon RPC", () => {
  test("round trips the handshake through a length-prefixed frame", () => {
    const request = {
      protocolMajor: 1,
      requestId: "request-1",
    };
    const frame = frameLocalRpc(encodeDaemonHandshakeRequest(request));
    expect(readLocalRpcFrame(frame)).not.toBeNull();
    expect(decodeDaemonHandshakeRequest(readLocalRpcFrame(frame)!)).toEqual(request);
  });

  test("round trips the daemon response", () => {
    const response = {
      protocolMajor: 1,
      requestId: "request-1",
      daemonId: "daemon-1",
      accepted: true,
      serverUrl: "https://coforge.example",
    };
    expect(decodeDaemonHandshakeResponse(encodeDaemonHandshakeResponse(response))).toEqual(
      response,
    );
  });

  test("round trips where a Workspace daemon's cloud connection stands", () => {
    const response = {
      protocolMajor: 1,
      requestId: "request-1",
      daemonId: "daemon-1",
      accepted: true,
      serverUrl: "https://coforge.example",
      cloudConnection: "not_connected",
      cloudConnectionError: "ECONNREFUSED",
    } as const;
    expect(decodeDaemonHandshakeResponse(encodeDaemonHandshakeResponse(response))).toEqual(
      response,
    );
  });

  test("round trips a parked runtime and the Workspace a lifecycle refusal names", () => {
    const response = {
      protocolMajor: 1,
      requestId: "request-1",
      accepted: false,
      runtimes: [
        {
          workspaceId: "workspace-1",
          computerId: "computer-1",
          enabled: true,
          processId: 0,
          instanceId: "",
          version: "",
          parkReason: "workspace_deleted",
        },
        {
          workspaceId: "workspace-2",
          computerId: "computer-1",
          enabled: true,
          processId: 42,
          instanceId: "i",
          version: "v",
          cloudConnection: "connecting" as const,
        },
        {
          workspaceId: "workspace-3",
          computerId: "computer-1",
          enabled: true,
          processId: 0,
          instanceId: "",
          version: "",
          lifecycleUnderWay: true,
        },
      ],
      error: "Workspace workspace-1 was deleted in CoForge (workspace_deleted).",
      errorCode: "workspace_deleted",
      workspaceId: "workspace-1",
    };
    expect(decodeDaemonCommandResponse(encodeDaemonCommandResponse(response))).toEqual(response);
  });

  test("round trips the Computer identity in a worker configure request", () => {
    const request = {
      protocolMajor: 1,
      requestId: "request-1",
      workspaceId: "workspace-1",
      computerId: "computer-1",
      workspaceRoot: "/workspaces/workspace-1",
      daemonApiKey: "worker-secret",
      expectedServerUrl: "https://coforge.example",
    };
    expect(
      decodeDaemonRuntimeConfigureRequest(encodeDaemonRuntimeConfigureRequest(request)),
    ).toEqual(request);
  });

  test("a login-style setup's configure carries loginSetup through the wire decode", () => {
    // Only a login-style setup may retire the login it replaced; the field survives the codec
    // so the daemon never retires a one-shot attach's login (task #417).
    const request = {
      protocolMajor: 1,
      requestId: "request-1",
      workspaceId: "workspace-1",
      computerId: "computer-1",
      workspaceRoot: "/workspaces/workspace-1",
      daemonApiKey: "worker-secret",
      expectedServerUrl: "https://coforge.example",
      serverHttpUrl: "https://coforge.example",
      loginSetup: true,
    };
    expect(
      decodeDaemonRuntimeConfigureRequest(encodeDaemonRuntimeConfigureRequest(request)),
    ).toEqual(request);
    const { loginSetup: _loginSetup, ...without } = request;
    expect(
      decodeDaemonRuntimeConfigureRequest(encodeDaemonRuntimeConfigureRequest(without)),
    ).toEqual(without);
  });

  test("a detach confirmation's revoked key round trips through the command response", () => {
    // `detach_key_revoked` reaches the CLI: a found-but-revoked key reports revoked, not
    // detached (task #417).
    const response = {
      protocolMajor: 1,
      requestId: "request-1",
      accepted: true,
      runtimes: [],
      detachKeyRevoked: true,
    };
    expect(decodeDaemonCommandResponse(encodeDaemonCommandResponse(response))).toEqual(response);
  });

  test("extracts multiple complete frames and preserves a partial frame", () => {
    const first = frameLocalRpc(new Uint8Array([1]));
    const second = frameLocalRpc(new Uint8Array([2, 3]));
    const partial = frameLocalRpc(new Uint8Array([4])).slice(0, 4);
    const input = new Uint8Array(first.byteLength + second.byteLength + partial.byteLength);
    input.set(first);
    input.set(second, first.byteLength);
    input.set(partial, first.byteLength + second.byteLength);

    expect(readLocalRpcFrames(input)).toEqual({
      frames: [new Uint8Array([1]), new Uint8Array([2, 3])],
      remainder: partial,
    });
  });
});

test("a configure answered while its start is still under way round trips that", () => {
  const response = {
    protocolMajor: 1,
    requestId: "request-1",
    accepted: true,
    lifecycleUnderWay: true,
  };
  expect(
    decodeDaemonRuntimeConfigureResponse(encodeDaemonRuntimeConfigureResponse(response)),
  ).toEqual(response);
});

describe("bounded local RPC frame size", () => {
  test("accepts a payload right at MAX_LOCAL_RPC_FRAME_BYTES and rejects 1 byte above on encode", () => {
    expect(MAX_LOCAL_RPC_FRAME_BYTES).toBe(4 * 1024 * 1024);
    const exact = new Uint8Array(MAX_LOCAL_RPC_FRAME_BYTES);
    exact[0] = 7;
    exact[exact.length - 1] = 9;
    const framed = frameLocalRpc(exact);
    const decoded = readLocalRpcFrame(framed);
    expect(decoded?.byteLength).toBe(MAX_LOCAL_RPC_FRAME_BYTES);
    expect(decoded?.[0]).toBe(7);
    expect(decoded?.[MAX_LOCAL_RPC_FRAME_BYTES - 1]).toBe(9);

    expect(() => frameLocalRpc(new Uint8Array(MAX_LOCAL_RPC_FRAME_BYTES + 1))).toThrow(
      LocalRpcFrameTooLargeError,
    );
  });

  test("rejects an oversized 4-byte frame header immediately without waiting for payload bytes", () => {
    const justOver = new Uint8Array(4);
    new DataView(justOver.buffer).setUint32(0, MAX_LOCAL_RPC_FRAME_BYTES + 1);
    expect(() => readLocalRpcFrame(justOver)).toThrow(LocalRpcFrameTooLargeError);

    const maxUint32 = new Uint8Array([0xff, 0xff, 0xff, 0xff]);
    expect(() => readLocalRpcFrame(maxUint32)).toThrow(LocalRpcFrameTooLargeError);

    const valid = frameLocalRpc(new Uint8Array([1, 2, 3]));
    const combined = new Uint8Array(valid.byteLength + 4);
    combined.set(valid);
    combined.set(maxUint32, valid.byteLength);
    expect(() => readLocalRpcFrames(combined)).toThrow(LocalRpcFrameTooLargeError);
  });
});
