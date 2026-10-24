import { expect, test } from "bun:test";
import type { AgentInboxListResponse, AgentInboxRequest } from "@lrm/coforge-sdk/agent";
import { handleAgentInboxListGet } from "#src/routes/api/agent/v1/inbox.conversations";

const PAGE: AgentInboxListResponse = {
  ok: true,
  view: "unread",
  items: [],
  totals: { conversations: 0, dms: 0, mentions: 0 },
  hasMore: false,
  nextBeforeSeq: null,
};

const get = (query: string) => {
  const calls: AgentInboxRequest[] = [];
  const response = handleAgentInboxListGet(
    new Request(`https://server.example/api/agent/v1/inbox/conversations${query}`),
    async (options) => {
      calls.push(options);
      return PAGE;
    },
  );
  return { response, calls };
};

test("the view defaults to unread and before_seq to the newest page", async () => {
  const { response, calls } = get("");
  expect((await response).status).toBe(200);
  expect(calls).toEqual([{ view: "unread", beforeSeq: undefined }]);
});

test("a view and a position are handed on", async () => {
  const { response, calls } = get("?view=mentions&before_seq=1790000000000");
  expect(await (await response).json()).toEqual(PAGE);
  expect(calls).toEqual([{ view: "mentions", beforeSeq: 1790000000000 }]);
});

test("an unknown view or a position that is not a positive integer is refused", async () => {
  for (const query of [
    "?view=all",
    "?before_seq=0",
    "?before_seq=-3",
    "?before_seq=x",
    "?before_seq=",
  ]) {
    const { response, calls } = get(query);
    expect((await response).status).toBe(400);
    expect(calls).toEqual([]);
  }
});
