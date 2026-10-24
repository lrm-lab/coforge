import { expect, test } from "bun:test";
import { handleAgentMessagesGet } from "#src/routes/api/agent/v1/messages";

const scope = { workspaceId: "workspace-1", agentId: "agent-1" };
const get = (search: string, readMessagesPage?: (...args: unknown[]) => Promise<unknown>) =>
  handleAgentMessagesGet(
    new Request(`https://server.example/api/agent/v1/messages${search}`),
    scope,
    {
      setAgentChannelMuted: async () => {},
      setAgentThreadFollowed: async () => {},
      readMessagesPage: readMessagesPage as never,
    },
  );

test("an unread read forwards the flag and returns where the read position stood and moved", async () => {
  let received: unknown;
  const response = await get(
    "?target=%40ada&unread=true&idempotencyKey=request-1",
    async (...args) => {
      received = args;
      return {
        messages: [],
        hasOlder: false,
        hasNewer: false,
        modelSeenUpToSeq: 9,
        unreadCursorBefore: 4,
        readPositionAfter: 9,
        moreUnread: true,
      };
    },
  );
  expect(received).toMatchObject([
    "workspace-1",
    "agent-1",
    "@ada",
    { unread: true, fromSequence: undefined },
  ]);
  expect(await response.json()).toMatchObject({
    modelSeenUpToSeq: 9,
    unreadCursorBefore: 4,
    readPositionAfter: 9,
    moreUnread: true,
  });
});

test("an unread read cannot be anchored or started from a sequence", async () => {
  for (const anchor of ["before=a", "after=a", "around=a", "fromSequence=3"]) {
    const response = await get(`?target=%40ada&unread=true&${anchor}`);
    expect(response.status).toBe(400);
  }
});

test("a read that is not unread does not carry the flag", async () => {
  let received: unknown;
  await get("?target=%40ada", async (...args) => {
    received = args;
    return { messages: [], hasOlder: false, hasNewer: false, modelSeenUpToSeq: null };
  });
  expect((received as unknown[])[3]).not.toHaveProperty("unread");
});

test("a sequence number reaches the repository untouched as the read anchor", async () => {
  let received: unknown;
  await get("?target=%40ada&after=4", async (...args) => {
    received = args;
    return { messages: [], hasOlder: false, hasNewer: false, modelSeenUpToSeq: null };
  });
  expect((received as unknown[])[3]).toMatchObject({ after: "4" });
});
