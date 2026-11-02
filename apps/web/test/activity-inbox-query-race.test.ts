import { expect, test } from "bun:test";
import { InfiniteQueryObserver, QueryClient, type InfiniteData } from "@tanstack/react-query";

import {
  pendingActivityDoneItems,
  settleActivityDone,
  startActivityDone,
  type ActivityDoneState,
} from "#src/features/inbox/activity-inbox-done";
import {
  ACTIVITY_INBOX_LISTS_KEY,
  cancelActivityInboxListReads,
  activityInboxQuery,
  projectPendingActivityCompletions,
} from "#src/features/inbox/activity-inbox-queries";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const item = (key: string) => ({
  key,
  unreadCount: 1,
  unreadMention: true,
  pinned: false,
});

function activityData(items: ReturnType<typeof item>[]) {
  return {
    pages: [
      {
        items,
        unreadItemCount: items.length,
        unreadMentionItemCount: items.length,
        activeItemCount: items.length,
      },
    ],
    pageParams: [0],
  };
}

test("an older Activity refetch cannot put an item back after Done", async () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const queryKey = [...ACTIVITY_INBOX_LISTS_KEY, "workspace-1", "all"];
  const completed = item("thread:1");
  const replacement = item("thread:stale-response");
  const initial = activityData([completed]);
  queryClient.setQueryData(queryKey, initial);

  const started = deferred();
  const release = deferred();
  const refetch = queryClient.fetchQuery({
    queryKey,
    queryFn: async () => {
      started.resolve();
      await release.promise;
      return activityData([replacement]);
    },
  });
  await started.promise;

  await cancelActivityInboxListReads(queryClient, "workspace-1");
  release.resolve();
  await refetch.catch(() => undefined);

  const cached = queryClient.getQueryData<typeof initial>(queryKey);
  expect(cached?.pages[0]?.items).toEqual([completed]);
  expect(projectPendingActivityCompletions(cached!, [completed]).pages[0]?.items).toEqual([]);
  queryClient.clear();
});

test("a later refetch cannot restore another completion that is still pending", async () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const queryKey = [...ACTIVITY_INBOX_LISTS_KEY, "workspace-1", "all"];
  const first = item("thread:a");
  const second = item("thread:b");
  const stale = activityData([first, second]);
  let pending = startActivityDone(new Map(), first);
  pending = startActivityDone(pending, second);

  await cancelActivityInboxListReads(queryClient, "workspace-1");
  await queryClient.fetchQuery({ queryKey, queryFn: async () => stale });
  const cached = queryClient.getQueryData<typeof stale>(queryKey)!;

  pending = settleActivityDone(pending, first);
  expect(
    projectPendingActivityCompletions(cached, pendingActivityDoneItems(pending)).pages[0],
  ).toMatchObject({
    items: [first],
    unreadItemCount: 1,
    unreadMentionItemCount: 1,
    activeItemCount: 1,
  });
  pending = settleActivityDone(pending, second);
  expect(projectPendingActivityCompletions(cached, pendingActivityDoneItems(pending))).toEqual(
    cached,
  );
  queryClient.clear();
});

test("kept filter data is reprojected when a Done starts", () => {
  const completed = item("thread:placeholder");
  const keptData = activityData([completed]);
  let pending: ActivityDoneState = new Map();

  expect(projectPendingActivityCompletions(keptData, pendingActivityDoneItems(pending))).toEqual(
    keptData,
  );
  pending = startActivityDone(pending, completed);
  expect(
    projectPendingActivityCompletions(keptData, pendingActivityDoneItems(pending)).pages[0]?.items,
  ).toEqual([]);
});

test("an older failed attempt cannot settle a retry projection for the same item", () => {
  const retried = item("thread:retry");
  let pending = startActivityDone(new Map(), retried);
  pending = startActivityDone(pending, retried);
  pending = settleActivityDone(pending, retried);

  expect(pendingActivityDoneItems(pending)).toEqual([retried]);
  expect(
    projectPendingActivityCompletions(activityData([retried]), pendingActivityDoneItems(pending))
      .pages[0]?.items,
  ).toEqual([]);

  pending = settleActivityDone(pending, retried);
  expect(pendingActivityDoneItems(pending)).toEqual([]);
});

const firstPage = (name: string, offset: number, next?: string) => ({
  name,
  next,
  streamPositions: { "user:viewer": { epoch: "e1", offset } },
});
type TestPage = ReturnType<typeof firstPage>;

/** The Activity list's key, without the page type its options tag it with. */
const listKey = [...ACTIVITY_INBOX_LISTS_KEY, "workspace-1", "all"];

/** The Activity list's Query, its reads stood in for by `read`. */
function activityList(queryClient: QueryClient, read: () => Promise<TestPage>) {
  const options = activityInboxQuery("workspace-1", "all");
  return new InfiniteQueryObserver<TestPage, Error, InfiniteData<TestPage>>(queryClient, {
    queryKey: listKey,
    queryFn: read,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.next,
    staleTime: Infinity,
    structuralSharing: options.structuralSharing,
  });
}

const names = (queryClient: QueryClient) =>
  queryClient.getQueryData<InfiniteData<TestPage>>(listKey)?.pages.map((page) => page.name);

test("a first page read for a new message survives a next page that was loading", async () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const queryKey = listKey;
  queryClient.setQueryData(queryKey, {
    pages: [firstPage("first, as first read", 1, "cursor-2")],
    pageParams: [undefined],
  });
  const release = deferred();
  const observer = activityList(queryClient, async () => {
    await release.promise;
    return firstPage("second", 1);
  });
  const unsubscribe = observer.subscribe(() => {});
  const loadingNext = observer.fetchNextPage();

  // The new message's first page lands while the next page is still loading.
  queryClient.setQueryData<InfiniteData<TestPage>>(queryKey, (current) =>
    current
      ? { ...current, pages: [firstPage("first, after the message", 5, "cursor-2")] }
      : current,
  );
  release.resolve();
  await loadingNext;

  expect(names(queryClient)).toEqual(["first, after the message", "second"]);
  unsubscribe();
});

test("a first page read earlier than the one held does not replace it", () => {
  const queryClient = new QueryClient();
  const queryKey = listKey;
  const unsubscribe = activityList(queryClient, async () => firstPage("unused", 0)).subscribe(
    () => {},
  );
  queryClient.setQueryData(queryKey, {
    pages: [firstPage("read later", 9), firstPage("second", 9)],
    pageParams: [undefined, "cursor-2"],
  });
  queryClient.setQueryData<InfiniteData<TestPage>>(queryKey, (current) =>
    current
      ? { ...current, pages: [firstPage("read earlier", 5), ...current.pages.slice(1)] }
      : current,
  );
  expect(names(queryClient)).toEqual(["read later", "second"]);
  unsubscribe();
});
