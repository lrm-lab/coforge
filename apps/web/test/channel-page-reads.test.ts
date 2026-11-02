import { afterEach, expect, test } from "bun:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { mockModuleForFile } from "./helpers/file-module-mock";

// A channel page's members roster and its composer's mention outsiders are read beside the window
// the page opens on, instead of after the page has rendered (task #427). Each stays its own server
// function: the loader only starts the reads earlier.

const reads: string[] = [];
let failMembers = false;

await mockModuleForFile("#src/features/conversations/channels.functions", () => ({
  loadPublicChannelMembers: async ({ data }: { data: { channelId: string } }) => {
    reads.push(`members:${data.channelId}`);
    if (failMembers) throw new Error("members read failed");
    return { humans: [], agents: [] };
  },
  loadPublicChannelMentionOutsiders: async ({ data }: { data: { channelId: string } }) => {
    reads.push(`outsiders:${data.channelId}`);
    return [];
  },
}));
const { channelMembersQuery, channelMentionOutsidersQuery, prefetchChannelPageReads } =
  await import("#src/features/conversations/channel-page-reads");

afterEach(() => {
  reads.length = 0;
  failMembers = false;
});

/** A client with the app's own query defaults (`router.tsx`), which the roster's freshness
 * relies on. */
const appClient = () =>
  new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: false } } });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const window = (page: { senderMemberId?: string; archived?: boolean }) =>
  Promise.resolve({ pages: [{}, page] });

test("a member opening an open channel reads its roster and its mention outsiders", async () => {
  const client = appClient();
  prefetchChannelPageReads(client, "channel-1", window({ senderMemberId: "member-1" }));
  await settle();
  expect(reads.sort()).toEqual(["members:channel-1", "outsiders:channel-1"]);
});

test("someone who is not a member has no composer, so only the roster is read", async () => {
  const client = appClient();
  prefetchChannelPageReads(client, "channel-1", window({}));
  await settle();
  expect(reads).toEqual(["members:channel-1"]);
});

test("an archived channel has no composer, so only the roster is read", async () => {
  const client = appClient();
  prefetchChannelPageReads(
    client,
    "channel-1",
    window({ senderMemberId: "member-1", archived: true }),
  );
  await settle();
  expect(reads).toEqual(["members:channel-1"]);
});

test("a window that fails to open still reads the roster, and nothing is thrown", async () => {
  const client = appClient();
  prefetchChannelPageReads(client, "channel-1", Promise.reject(new Error("window failed")));
  await settle();
  expect(reads).toEqual(["members:channel-1"]);
});

test("the header mounting just after the loader's read takes it without reading again", async () => {
  const client = appClient();
  prefetchChannelPageReads(client, "channel-1", window({ senderMemberId: "member-1" }));
  await settle();
  reads.length = 0;

  const members = new QueryObserver(client, channelMembersQuery("channel-1"));
  const outsiders = new QueryObserver(client, channelMentionOutsidersQuery("channel-1"));
  const stop = [members.subscribe(() => {}), outsiders.subscribe(() => {})];
  await settle();

  expect(reads).toEqual([]);
  expect(members.getCurrentResult().status).toBe("success");
  stop.forEach((unsubscribe) => unsubscribe());
});

test("a roster read that failed is read again when the header mounts", async () => {
  const client = appClient();
  failMembers = true;
  prefetchChannelPageReads(client, "channel-1", window({}));
  await settle();
  failMembers = false;
  reads.length = 0;

  const members = new QueryObserver(client, channelMembersQuery("channel-1"));
  const stop = members.subscribe(() => {});
  await settle();

  expect(reads).toEqual(["members:channel-1"]);
  stop();
});
