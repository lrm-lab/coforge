import { expect, test } from "bun:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import {
  conversationOpenQuery,
  markOpenReadStale,
} from "#src/features/conversations/conversation-open-query";

const answered = { firstUnread: { id: "m6", sequence: 6 } };

test("a read nobody observes is dropped when the cursor moves, so a click reads afresh", () => {
  const queryClient = new QueryClient();
  const { queryKey } = conversationOpenQuery("c1");
  // A loader's read ahead (the pointer rested on the link); no pane took it up.
  queryClient.setQueryData(queryKey, answered);
  markOpenReadStale(queryClient, "c1");
  expect(queryClient.getQueryState(queryKey)).toBeUndefined();
});

test("an observed read is kept for the open on screen, and only marked stale", () => {
  const queryClient = new QueryClient();
  const options = conversationOpenQuery("c1");
  queryClient.setQueryData(options.queryKey, answered);
  const observer = new QueryObserver(queryClient, { ...options, enabled: true });
  const stop = observer.subscribe(() => undefined);
  markOpenReadStale(queryClient, "c1");
  expect(queryClient.getQueryData(options.queryKey)).toEqual(answered);
  expect(queryClient.getQueryState(options.queryKey)?.isInvalidated).toBe(true);
  stop();
  queryClient.clear();
});
