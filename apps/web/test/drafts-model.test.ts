import { expect, test } from "bun:test";

import type { DeviceDraft } from "#src/features/conversations/composer-drafts-index";
import {
  countDrafts,
  draftRoute,
  resolveDrafts,
  type DraftHome,
} from "#src/features/conversations/drafts-model";

const general: DraftHome = {
  kind: "channel",
  channel: { name: "general", visibility: "public" },
};
const scout: DraftHome = {
  kind: "dm",
  direct: { name: "Scout", peer: { kind: "agent", agentId: "agent-1", avatarUrl: null } },
};
const homes = new Map<string, DraftHome>([
  ["chan-1", general],
  ["dm-1", scout],
]);

const withTasks = { taskDrafts: true };

const channelDraft: DeviceDraft = {
  key: "k-channel",
  place: { conversationId: "chan-1", target: { kind: "conversation" } },
  body: "in a channel",
  updatedAt: 5,
};
const dmDraft: DeviceDraft = {
  key: "k-dm",
  place: { conversationId: "dm-1", target: { kind: "conversation" } },
  body: "in a dm",
  updatedAt: 4,
};
const threadDraft: DeviceDraft = {
  key: "k-thread",
  place: { conversationId: "chan-1", target: { kind: "thread", threadRootId: "root-1" } },
  body: "in a thread",
  updatedAt: 3,
};
const taskDraft: DeviceDraft = {
  key: "k-task",
  place: { conversationId: "dm-1", target: { kind: "task", number: 9 } },
  body: "on a task",
  updatedAt: null,
};
const elsewhereDraft: DeviceDraft = {
  key: "k-elsewhere",
  place: { conversationId: "other-workspace-chat", target: { kind: "conversation" } },
  body: "in another workspace",
  updatedAt: 2,
};

test("each draft becomes a row for the channel or DM it was written in, in the order given", () => {
  expect(resolveDrafts([channelDraft, dmDraft, threadDraft, taskDraft], homes, withTasks)).toEqual([
    {
      key: "k-channel",
      body: "in a channel",
      updatedAt: 5,
      conversationId: "chan-1",
      home: general,
      target: { kind: "conversation" },
    },
    {
      key: "k-dm",
      body: "in a dm",
      updatedAt: 4,
      conversationId: "dm-1",
      home: scout,
      target: { kind: "conversation" },
    },
    {
      key: "k-thread",
      body: "in a thread",
      updatedAt: 3,
      conversationId: "chan-1",
      home: general,
      target: { kind: "thread", threadRootId: "root-1" },
    },
    {
      key: "k-task",
      body: "on a task",
      updatedAt: null,
      conversationId: "dm-1",
      home: scout,
      target: { kind: "task", number: 9 },
    },
  ]);
});

test("a draft whose conversation is not in this Workspace is left out, and not counted", () => {
  const taskElsewhere: DeviceDraft = {
    ...taskDraft,
    place: { conversationId: "other-board", target: { kind: "task", number: 1 } },
  };
  const drafts = [elsewhereDraft, channelDraft, taskElsewhere, taskDraft];
  expect(resolveDrafts(drafts, homes, withTasks).map((row) => row.key)).toEqual([
    "k-channel",
    "k-task",
  ]);
  expect(countDrafts(drafts, homes, withTasks)).toBe(2);
});

test("Task discussion drafts are hidden and not counted while task conversations are off", () => {
  const drafts = [channelDraft, taskDraft, threadDraft];
  const withoutTasks = { taskDrafts: false };
  expect(resolveDrafts(drafts, homes, withoutTasks).map((row) => row.key)).toEqual([
    "k-channel",
    "k-thread",
  ]);
  expect(countDrafts(drafts, homes, withoutTasks)).toBe(2);
  expect(resolveDrafts(drafts, homes, withTasks).map((row) => row.key)).toEqual([
    "k-channel",
    "k-task",
    "k-thread",
  ]);
  expect(countDrafts(drafts, homes, withTasks)).toBe(3);
});

test("a row opens its channel or DM, with the thread or Task popup open where the draft was written", () => {
  const [channel, dm, thread, task] = resolveDrafts(
    [channelDraft, dmDraft, threadDraft, taskDraft],
    homes,
    withTasks,
  );
  expect(draftRoute(channel!, "acme")).toEqual({
    to: "/w/$workspaceSlug/channel/$channelId",
    params: { workspaceSlug: "acme", channelId: "chan-1" },
    search: {},
  });
  expect(draftRoute(dm!, "acme")).toEqual({
    to: "/w/$workspaceSlug/dm/$dmId",
    params: { workspaceSlug: "acme", dmId: "dm-1" },
    search: {},
  });
  expect(draftRoute(thread!, "acme").search).toEqual({ threadRootId: "root-1" });
  expect(draftRoute(task!, "acme")).toEqual({
    to: "/w/$workspaceSlug/dm/$dmId",
    params: { workspaceSlug: "acme", dmId: "dm-1" },
    search: { task: 9 },
  });
});
