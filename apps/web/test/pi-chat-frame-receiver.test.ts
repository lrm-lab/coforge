import { expect, test } from "bun:test";
import { createPiChatFrameMethod } from "#src/server/pi-chat/pi-chat-frame-receiver.server";
import { piChatFrames, encodePiChatFrame } from "@lrm/coforge-sdk/internal/pi-chat-wire";

test("only the current Computer owner receives Pi live frames; unsolicited command replies remain scoped", async () => {
  const scope = {
    userId: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
    computerId: crypto.randomUUID(),
  };
  let owned = true;
  const published: string[] = [];
  let accepted = 0;
  const receiver = createPiChatFrameMethod({
    canUse: async () => owned,
    results: {
      accept: async () => {
        accepted++;
      },
    },
    publish: async (channel) => {
      published.push(channel);
    },
  });
  const frame = piChatFrames(scope, crypto.randomUUID(), "event", {
    sessionId: crypto.randomUUID(),
  })[0]!;
  const bytes = encodePiChatFrame(frame);
  expect(
    await receiver(bytes, { principal: { ...scope, userId: crypto.randomUUID() } }),
  ).toMatchObject({ code: 403 });
  expect(
    await receiver(bytes, { principal: { ...scope, agentId: crypto.randomUUID() } }),
  ).toMatchObject({ code: 403 });
  expect(await receiver(bytes, { principal: scope })).toBeInstanceOf(Uint8Array);
  expect(published).toEqual([`chat:user:${scope.userId}`]);
  owned = false;
  expect(await receiver(bytes, { principal: scope })).toMatchObject({ code: 403 });
  expect(published).toHaveLength(1);
  owned = true;
  await receiver(encodePiChatFrame({ ...frame, kind: "result" }), { principal: scope });
  expect(accepted).toBe(1);
  expect(published).toHaveLength(1);
  expect(await receiver(new Uint8Array([0]), { principal: scope })).toMatchObject({ code: 400 });
});
