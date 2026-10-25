import { expect, test } from "bun:test";
import { DaemonConnection } from "#src/connection/daemon-connection";
import type { CentrifugeWorkspaceClient } from "#src/connection/centrifuge-workspace-client";
const config = { workspaceId: crypto.randomUUID(), computerId: crypto.randomUUID() };
function fakeClient() {
  let connected = () => {};
  let failed = (_error: unknown) => {};
  let disconnected = (_context?: { code: number; reason: string }) => {};
  let publication = (_event: { channel: string; data: Uint8Array }) => {};
  const client: CentrifugeWorkspaceClient = {
    on(event, callback) {
      if (event === "connected") connected = callback as () => void;
      else if (event === "disconnected") disconnected = callback as typeof disconnected;
      else if (event === "error") failed = callback as (error: unknown) => void;
      else publication = callback as typeof publication;
    },
    connect() {
      connected();
    },
    disconnect() {},
    rpc: async () => new Uint8Array(),
  };
  return {
    client,
    connect: () => connected(),
    disconnect: (context?: { code: number; reason: string }) => disconnected(context),
    fail: (error: unknown) => failed(error),
    publish: (channel: string, data: Uint8Array) => publication({ channel, data }),
  };
}

import {
  encodePiChatRequest,
  decodePiChatFrame,
  piChatFrames,
  PI_CHAT_FRAME_METHOD,
} from "@lrm/coforge-sdk/internal/pi-chat-wire";

test("Pi chat uses the existing daemon socket and refuses commands for another Computer", async () => {
  const fake = fakeClient();
  const own = { ...config, workspaceId: crypto.randomUUID(), computerId: crypto.randomUUID() };
  const request = {
    workspaceId: own.workspaceId,
    computerId: own.computerId,
    userId: crypto.randomUUID(),
    requestId: crypto.randomUUID(),
    command: { action: "list" as const },
  };
  const transport = new DaemonConnection("wss://cloud.example", () => fake.client);
  const received = Promise.withResolvers<unknown>();
  let count = 0;
  transport.onPiChatRequest(async (value) => {
    count++;
    received.resolve(value);
  });
  await transport.start("daemon-key", own);
  try {
    fake.publish(
      `daemon:${own.workspaceId}:${own.computerId}`,
      encodePiChatRequest({ ...request, computerId: crypto.randomUUID() }),
    );
    fake.publish(`daemon:${own.workspaceId}:${own.computerId}`, encodePiChatRequest(request));
    expect(await received.promise).toEqual(request);
    expect(count).toBe(1);
    const frame = piChatFrames(request, request.requestId, "result", { sessions: [] })[0]!;
    fake.client.rpc = async (method, data) => {
      expect(method).toBe(PI_CHAT_FRAME_METHOD);
      expect(decodePiChatFrame(data)).toEqual(frame);
      return new Uint8Array();
    };
    await transport.sendPiChatFrame(frame);
  } finally {
    await transport.stop();
  }
});
