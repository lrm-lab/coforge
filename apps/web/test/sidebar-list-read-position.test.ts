import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";

import {
  channelNamesQueryKey,
  sidebarChannelsQueryKey,
  sidebarDirectsQueryKey,
} from "#src/features/conversations/conversation-query-keys";
import type { ChatList } from "#src/features/conversations/conversation-unread";
import { listReadPosition } from "#src/features/conversations/sidebar-collections";
import { savedMessagesQueryKey } from "#src/features/conversations/saved-messages-collection";

describe("listReadPosition", () => {
  const channel = "chat:user:viewer";
  const readAt = (offset: number, epoch = "e1") => ({
    streamPositions: { [channel]: { offset, epoch } },
  });

  test("finds where each list was last read, in that list's own query", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(sidebarChannelsQueryKey("w"), { rows: [], ...readAt(1) });
    queryClient.setQueryData(sidebarDirectsQueryKey("w"), { rows: [], ...readAt(2) });
    queryClient.setQueryData(channelNamesQueryKey("w"), { names: [], ...readAt(3) });
    queryClient.setQueryData(savedMessagesQueryKey("w"), { entries: [], ...readAt(4) });
    const lists: ChatList[] = ["channels", "dms", "channelNames", "saved"];
    expect(
      await Promise.all(lists.map((list) => listReadPosition(queryClient, "w", list, channel))),
    ).toEqual([1, 2, 3, 4].map((offset) => ({ offset, epoch: "e1" })));
  });

  test("a list read without a position for the channel, or not read, has none", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(channelNamesQueryKey("w"), { names: [], ...readAt(3) });
    queryClient.setQueryData(savedMessagesQueryKey("w"), { entries: [], streamPositions: {} });
    expect(await listReadPosition(queryClient, "w", "channelNames", "chat:workspace:w")).toBe(
      undefined,
    );
    expect(await listReadPosition(queryClient, "w", "saved", channel)).toBe(undefined);
    expect(await listReadPosition(queryClient, "w", "dms", channel)).toBe(undefined);
  });

  test("a read under way settles first, and its position is the one reported", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(savedMessagesQueryKey("w"), { entries: [], ...readAt(3) });
    let settle: (read: unknown) => void = () => {};
    const answer = new Promise<unknown>((resolve) => (settle = resolve));
    const reading = queryClient.fetchQuery({
      queryKey: savedMessagesQueryKey("w"),
      queryFn: () => answer,
      staleTime: 0,
    });
    const position = listReadPosition(queryClient, "w", "saved", channel);
    settle({ entries: [], ...readAt(8) });
    await reading;
    expect(await position).toEqual({ offset: 8, epoch: "e1" });
  });
});
