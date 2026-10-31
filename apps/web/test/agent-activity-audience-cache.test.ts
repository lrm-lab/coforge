import { expect, test } from "bun:test";

import {
  cachedActivityAudience,
  type ActivityAudienceReads,
  type AudienceAgent,
  type ChannelPeople,
} from "#src/server/agents/agent-activity-audience.server";

/**
 * Task #302: every frame of an Agent's stream asks who sees it live, so the answers are
 * remembered (`cachedActivityAudience`): a frame costs no read once its conversation is known,
 * and a change of a channel's people is seen at once through `forget`.
 */
const everyone: AudienceAgent = { visibility: "public", ownerId: "owner", systemKind: null };
const ownersOnly: AudienceAgent = { visibility: "private", ownerId: "owner", systemKind: null };

function counted(channels: Record<string, ChannelPeople>) {
  const reads = { governing: 0, people: 0, seeing: 0 };
  const store: ActivityAudienceReads = {
    governingChannel: async (_workspaceId, conversationId) => {
      reads.governing += 1;
      if (conversationId === "dm-1") return null;
      if (conversationId === "discussion-1") return "private-1";
      return conversationId in channels ? conversationId : undefined;
    },
    channelPeople: async (channelId) => {
      reads.people += 1;
      return channels[channelId]!;
    },
    seeingAgent: async (_workspaceId, userIds) => {
      reads.seeing += 1;
      return userIds.filter((userId) => userId === "admin");
    },
  };
  return { reads, store };
}

const frame = (conversationId: string) => ({
  workspaceId: "workspace-1",
  agentId: "agent-1",
  conversationId,
});

test("a public channel's or a DM's frames read nothing after the first", async () => {
  const { reads, store } = counted({ "public-1": { private: false } });
  const audience = cachedActivityAudience(store);
  for (let index = 0; index < 100; index += 1) {
    expect(await audience.audience(frame("public-1"), async () => everyone)).toBeUndefined();
    expect(await audience.audience(frame("dm-1"), async () => everyone)).toBeUndefined();
  }
  // One read of each conversation's channel, one of the public channel's visibility: 3 in all,
  // where every frame read its conversation before.
  expect(reads).toEqual({ governing: 2, people: 1, seeing: 0 });
});

test("a private channel's frames go to its people, read once, Task conversation included", async () => {
  const { reads, store } = counted({
    "private-1": { private: true, userIds: ["member", "admin"] },
  });
  const audience = cachedActivityAudience(store);
  for (let index = 0; index < 100; index += 1) {
    expect(await audience.audience(frame("private-1"), async () => everyone)).toEqual([
      "member",
      "admin",
    ]);
    expect(await audience.audience(frame("discussion-1"), async () => everyone)).toEqual([
      "member",
      "admin",
    ]);
  }
  expect(reads).toEqual({ governing: 2, people: 1, seeing: 0 });
  // An Agent not every member sees: only those who see it, its people's roles read per frame.
  expect(await audience.audience(frame("private-1"), async () => ownersOnly)).toEqual(["admin"]);
  expect(reads.seeing).toBe(1);
});

test("a change of a channel's people is seen at the next frame", async () => {
  const channels: Record<string, ChannelPeople> = {
    "private-1": { private: true, userIds: ["member"] },
  };
  const { reads, store } = counted(channels);
  const audience = cachedActivityAudience(store);
  expect(await audience.audience(frame("private-1"), async () => everyone)).toEqual(["member"]);
  channels["private-1"] = { private: true, userIds: ["member", "joiner"] };
  audience.forget("private-1");
  expect(await audience.audience(frame("private-1"), async () => everyone)).toEqual([
    "member",
    "joiner",
  ]);
  // Turned public: every frame goes out as before.
  channels["private-1"] = { private: false };
  audience.forget();
  expect(await audience.audience(frame("private-1"), async () => everyone)).toBeUndefined();
  // The conversation's channel never changes, so it was read once.
  expect(reads).toEqual({ governing: 1, people: 3, seeing: 0 });
});

test("a read that started before a change does not stand for the channel after it", async () => {
  let release: (people: ChannelPeople) => void = () => {};
  let calls = 0;
  const audience = cachedActivityAudience({
    governingChannel: async () => "private-1",
    channelPeople: () => {
      calls += 1;
      return calls === 1
        ? new Promise<ChannelPeople>((resolve) => (release = resolve))
        : Promise.resolve({ private: true, userIds: ["member", "joiner"] });
    },
    seeingAgent: async () => [],
  });
  const first = audience.audience(frame("private-1"), async () => everyone);
  await Bun.sleep(0);
  audience.forget("private-1");
  release({ private: true, userIds: ["member"] });
  expect(await first).toEqual(["member"]);
  expect(await audience.audience(frame("private-1"), async () => everyone)).toEqual([
    "member",
    "joiner",
  ]);
});

test("a failed read names nobody and is asked again", async () => {
  let fail = true;
  const audience = cachedActivityAudience({
    governingChannel: async () => {
      if (fail) throw new Error("database unavailable");
      return "private-1";
    },
    channelPeople: async () => ({ private: true, userIds: ["member"] }),
    seeingAgent: async () => [],
  });
  expect(await audience.audience(frame("private-1"), async () => everyone)).toEqual([]);
  fail = false;
  expect(await audience.audience(frame("private-1"), async () => everyone)).toEqual(["member"]);
});

test("a remembered channel's people stand 30 s from the read, however busy the channel", async () => {
  let clock = 0;
  const { reads, store } = counted({ "private-1": { private: true, userIds: ["member"] } });
  const audience = cachedActivityAudience(store, { now: () => clock });
  // A frame every second: hits never renew it, so a lost forget is outlived by 30 s at most.
  for (; clock < 31_000; clock += 1_000)
    await audience.audience(frame("private-1"), async () => everyone);
  expect(reads.people).toBe(2);
});

test("a conversation is remembered for its own Workspace only", async () => {
  const { reads, store } = counted({ "private-1": { private: true, userIds: ["member"] } });
  const audience = cachedActivityAudience({
    ...store,
    governingChannel: async (workspaceId, conversationId) =>
      workspaceId === "workspace-1"
        ? store.governingChannel(workspaceId, conversationId)
        : undefined,
  });
  expect(await audience.audience(frame("private-1"), async () => everyone)).toEqual(["member"]);
  // Another Workspace's frame naming this channel finds no conversation, cached or not.
  const elsewhere = { ...frame("private-1"), workspaceId: "workspace-2" };
  expect(await audience.audience(elsewhere, async () => everyone)).toBeUndefined();
  expect(reads.governing).toBe(1);
});

test("forget works handed on alone, as the invalidation registers it", async () => {
  const channels: Record<string, ChannelPeople> = {
    "private-1": { private: true, userIds: ["member"] },
  };
  const { store } = counted(channels);
  const audience = cachedActivityAudience(store);
  const { forget } = audience;
  expect(await audience.audience(frame("private-1"), async () => everyone)).toEqual(["member"]);
  channels["private-1"] = { private: true, userIds: [] };
  forget("private-1");
  expect(await audience.audience(frame("private-1"), async () => everyone)).toEqual([]);
});
