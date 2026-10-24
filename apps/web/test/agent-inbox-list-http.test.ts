import { expect, test } from "bun:test";
import type { AgentInboxListResponse, AgentInboxRequest } from "@lrm/coforge-sdk/agent";
import { handleAgentInboxListGet } from "#src/routes/api/agent/v1/inbox.conversations";

const PAGE: AgentInboxListResponse = {
  ok: true,
  view: "unread",
  items: [],
  totals: { conversations: 0, dms: 0, mentions: 0 },
  hasMore: false,
  nextBefore: null,
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

test("the view defaults to unread and before to the newest page", async () => {
  const { response, calls } = get("");
  expect((await response).status).toBe(200);
  expect(calls).toEqual([{ view: "unread", before: undefined }]);
});

test("a view and a position are handed on", async () => {
  const { response, calls } = get("?view=mentions&before=1790000000000");
  expect(await (await response).json()).toEqual(PAGE);
  expect(calls).toEqual([{ view: "mentions", before: 1790000000000 }]);
});

test("an unknown view or a position that is not a positive integer is refused", async () => {
  for (const query of ["?view=all", "?before=0", "?before=-3", "?before=x", "?before="]) {
    const { response, calls } = get(query);
    expect((await response).status).toBe(400);
    expect(calls).toEqual([]);
  }
});
