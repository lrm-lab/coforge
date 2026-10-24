import type { LocalAgentMessageRequest, LocalSearchPaging } from "@lrm/coforge-sdk/internal";

/** What a `message search` asks for, as the daemon forwards it to the server. */
export function searchFields(request: LocalAgentMessageRequest) {
  const { query, sender, sort, offset, cursor } = request;
  return { query, sender, sort, offset, cursor };
}

/** The paging fields of a `message search` answer, which the daemon relays to the Agent as the
 * server gave them. */
export function searchPage(result: LocalSearchPaging): LocalSearchPaging {
  const { hasMore, nextCursor, incomplete, searchedMessages, searchedThrough } = result;
  return { hasMore, nextCursor, incomplete, searchedMessages, searchedThrough };
}
