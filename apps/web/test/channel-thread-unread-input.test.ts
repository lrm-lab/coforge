import { expect, test } from "bun:test";
import { channelThreadUnreadsInput } from "#src/features/conversations/channel-threads.functions";

test("channel thread unread lists accept at most 100 requested ids before deduplication", () => {
  const workspaceId = crypto.randomUUID();
  const ids = Array.from({ length: 100 }, () => crypto.randomUUID());
  expect(channelThreadUnreadsInput.safeParse({ workspaceId, conversationIds: ids }).success).toBe(
    true,
  );
  expect(
    channelThreadUnreadsInput.safeParse({ workspaceId, conversationIds: [...ids, ids[0]] }).success,
  ).toBe(false);
});
