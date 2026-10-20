import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";

import type {
  ReactionSummary,
  VersionedReactions,
} from "#src/features/conversations/message-reactions";
import { createReactionSync } from "#src/features/conversations/reaction-sync";
import {
  conversationThreadQueryKey,
  loadedThreadReplies,
  updateLoadedReply,
  type ThreadReplies,
} from "#src/features/conversations/thread-cache";

const CONVERSATION = "conversation-1";
const dev = { id: "user-dev", label: "Dev User" };
const jordan = { id: "user-jordan", label: "Jordan Lee" };
const casey = { id: "user-casey", label: "Casey Morgan" };
const thumbs: ReactionSummary = { emoji: "👍", count: 1, reactors: [jordan] };
const party: ReactionSummary = { emoji: "🎉", count: 1, reactors: [casey] };
const mine: ReactionSummary = { emoji: "👍", count: 1, reactors: [dev] };

type Message = {
  id: string;
  sequence: number;
  reactions?: ReactionSummary[];
  reactionVersion?: number;
};

/** Resolves or rejects a held call when the test says. */
function gate<T>() {
  let release!: (value: T) => void;
  let fail!: (error: Error) => void;
  const promise = new Promise<T>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  return { promise, release, fail };
}

/**
 * One open conversation as the page holds it: the window's messages and an open thread's replies
 * in the Query cache, written the way `useConversationQuery` writes them. Like the page's memoized
 * list, `loaded()` shows the window only as of the last `render()`, while `update` writes the
 * cache at once. Every repair read is held open until the test answers it.
 */
function harness(window: Message[], replies: Message[] = []) {
  const client = new QueryClient();
  let cached = window;
  let rendered = window;
  if (replies.length)
    client.setQueryData<ThreadReplies<Message>>(conversationThreadQueryKey(CONVERSATION, "root"), {
      replies,
    });
  const reads: { ids: string[]; answer: (answer: Record<string, VersionedReactions>) => void }[] =
    [];
  const failures: (() => void)[] = [];
  let resyncs = 0;
  const sync = createReactionSync<Message>({
    loaded: () => [...rendered, ...loadedThreadReplies<Message>(client, CONVERSATION)],
    update: (messageId, update) => {
      cached = cached.map((message) => (message.id === messageId ? update(message) : message));
      updateLoadedReply<Message>(client, CONVERSATION, messageId, update);
    },
    load: (ids) =>
      new Promise((resolve, reject) => {
        reads.push({ ids, answer: resolve });
        failures.push(() => reject(new Error("offline")));
      }),
    resync: async () => {
      resyncs += 1;
    },
  });
  const find = (messageId: string) =>
    [...cached, ...loadedThreadReplies<Message>(client, CONVERSATION)].find(
      (message) => message.id === messageId,
    );
  return {
    sync,
    reads,
    failures,
    resyncs: () => resyncs,
    render: () => {
      rendered = cached;
    },
    /** A re-read of the window replaced a message, as a refetch or a merged update does. */
    reread: (message: Message) => {
      cached = cached.map((other) => (other.id === message.id ? message : other));
    },
    reactionsOf: (messageId: string) => find(messageId)?.reactions,
    versionOf: (messageId: string) => find(messageId)?.reactionVersion,
  };
}

const message = (id: string, sequence: number, reactions?: ReactionSummary[], version = 0) => ({
  id,
  sequence,
  reactionVersion: version,
  ...(reactions ? { reactions } : {}),
});

describe("createReactionSync", () => {
  test("a newer summary shows, with its version", () => {
    const h = harness([message("m1", 1, [thumbs], 2)]);
    expect(h.sync.apply("m1", { reactions: [thumbs, party], version: 3 })).toBe(true);
    expect(h.reactionsOf("m1")).toEqual([thumbs, party]);
    expect(h.versionOf("m1")).toBe(3);
  });

  test("a summary no newer than the shown one is ignored", () => {
    const h = harness([message("m1", 1, [thumbs], 2)]);
    expect(h.sync.apply("m1", { reactions: null, version: 2 })).toBe(false);
    expect(h.sync.apply("m1", { reactions: null, version: 1 })).toBe(false);
    expect(h.reactionsOf("m1")).toEqual([thumbs]);
  });

  test("two summaries in one task compare against the cache, not the last render", () => {
    const h = harness([message("m1", 1, [thumbs], 4)]);
    // Both arrive before the page renders again, so `loaded()` still says version 4.
    h.sync.apply("m1", { reactions: [thumbs, party], version: 6 });
    h.sync.apply("m1", { reactions: [party], version: 5 });
    expect(h.reactionsOf("m1")).toEqual([thumbs, party]);
    expect(h.versionOf("m1")).toBe(6);
  });

  test("a summary without a numeric version, from an older server, is ignored", () => {
    const h = harness([message("m1", 1, [thumbs], 1)]);
    const unversioned = { reactions: null } as unknown as VersionedReactions;
    expect(h.sync.apply("m1", unversioned)).toBe(false);
    expect(h.reactionsOf("m1")).toEqual([thumbs]);
  });

  test("an add and a remove delivered in reverse order end as the newer one says", () => {
    const h = harness([message("m1", 1)]);
    // Casey added 🎉 (version 1), then removed it (version 2); the removal arrives first.
    h.sync.apply("m1", { reactions: null, version: 2 });
    h.sync.apply("m1", { reactions: [party], version: 1 });
    expect(h.reactionsOf("m1")).toBeUndefined();
    expect(h.versionOf("m1")).toBe(2);
  });

  test("a message that is not loaded is left alone", () => {
    const h = harness([message("m1", 1, [thumbs], 1)]);
    expect(h.sync.apply("elsewhere", { reactions: [party], version: 9 })).toBe(false);
    expect(h.reactionsOf("m1")).toEqual([thumbs]);
  });

  test("a reply in an open thread is updated where the thread holds it", () => {
    const h = harness([message("root", 1)], [message("r2", 2)]);
    h.sync.apply("r2", { reactions: [party], version: 1 });
    expect(h.reactionsOf("r2")).toEqual([party]);
    expect(h.versionOf("r2")).toBe(1);
  });

  test("repair reads every loaded message, window and open threads, newest first, in one call", async () => {
    const h = harness([message("m1", 1), message("m3", 3)], [message("r2", 2), message("r4", 4)]);
    const repair = h.sync.repair();
    expect(h.reads.map((read) => read.ids)).toEqual([["r4", "m3", "r2", "m1"]]);
    h.reads[0]!.answer({
      m1: { reactions: [thumbs], version: 1 },
      r4: { reactions: [party], version: 1 },
    });
    await repair;
    expect(h.reactionsOf("m1")).toEqual([thumbs]);
    expect(h.reactionsOf("r4")).toEqual([party]);
  });

  test("repair asks about the newest 200 loaded messages at most", () => {
    const h = harness(
      Array.from({ length: 205 }, (_, index) => message(`m${index + 1}`, index + 1)),
    );
    void h.sync.repair();
    const ids = h.reads[0]!.ids;
    expect(ids).toHaveLength(200);
    expect(ids[0]).toBe("m205");
    expect(ids.at(-1)).toBe("m6");
  });

  test("repairs asked for during a read share it, and read once more after it", async () => {
    const h = harness([message("m1", 1)]);
    const first = h.sync.repair();
    const second = h.sync.repair();
    void h.sync.repair();
    expect(second).toBe(first);
    expect(h.reads).toHaveLength(1);
    h.reads[0]!.answer({});
    await first;
    expect(h.reads).toHaveLength(2);
    h.reads[1]!.answer({});
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.reads).toHaveLength(2);
  });

  test("a repair read older than an event already shown does not undo it", async () => {
    const h = harness([message("m1", 1, [thumbs], 1)]);
    const repair = h.sync.repair();
    h.sync.apply("m1", { reactions: [thumbs, party], version: 3 });
    h.reads[0]!.answer({ m1: { reactions: [thumbs], version: 2 } });
    await repair;
    expect(h.reactionsOf("m1")).toEqual([thumbs, party]);
  });

  test("a failed repair read leaves the reactions as they are", async () => {
    const h = harness([message("m1", 1, [thumbs], 1)]);
    const repair = h.sync.repair();
    h.failures[0]!();
    await repair;
    expect(h.reactionsOf("m1")).toEqual([thumbs]);
    expect(h.versionOf("m1")).toBe(1);
  });

  test("the viewer's pending 👍 survives another person's newer event that lacks it", async () => {
    const h = harness([message("m1", 1, undefined, 1)]);
    const server = gate<VersionedReactions>();
    const done = h.sync.toggle("m1", "👍", dev, true, () => server.promise);
    expect(h.reactionsOf("m1")).toEqual([mine]);
    // Casey reacted before the viewer's write committed.
    h.sync.apply("m1", { reactions: [party], version: 2 });
    expect(h.reactionsOf("m1")).toEqual([party, mine]);
    // The viewer's answer is the newest, and holds both.
    server.release({ reactions: [party, mine], version: 3 });
    await done;
    expect(h.reactionsOf("m1")).toEqual([party, mine]);
    expect(h.versionOf("m1")).toBe(3);
  });

  test("an answer older than an applied event keeps the newer state and the other pending clicks", async () => {
    const h = harness([message("m1", 1, undefined, 1)]);
    const first = gate<VersionedReactions>();
    const done = h.sync.toggle("m1", "👍", dev, true, () => first.promise);
    void h.sync.toggle("m1", "🎉", dev, true, () => new Promise(() => {}));
    // Jordan's 👍 and the viewer's own 👍 are both in version 3; the viewer's answer said 2.
    const both = { emoji: "👍", count: 2, reactors: [dev, jordan] };
    h.sync.apply("m1", { reactions: [both], version: 3 });
    first.release({ reactions: [mine], version: 2 });
    await done;
    expect(h.reactionsOf("m1")).toEqual([both, { emoji: "🎉", count: 1, reactors: [dev] }]);
    expect(h.versionOf("m1")).toBe(3);
  });

  test("a re-read newer than the click's start becomes its base, so an older answer cannot win", async () => {
    const h = harness([message("m1", 1, [thumbs], 4)]);
    const server = gate<VersionedReactions>();
    const done = h.sync.toggle("m1", "🎉", dev, true, () => server.promise);
    // A refetch brings version 6, which already holds the viewer's 🎉 and Casey's 🎉.
    const six = [thumbs, { emoji: "🎉", count: 2, reactors: [casey, dev] }];
    h.reread(message("m1", 1, six, 6));
    server.release({ reactions: [thumbs, { emoji: "🎉", count: 1, reactors: [dev] }], version: 5 });
    await done;
    expect(h.reactionsOf("m1")).toEqual(six);
    expect(h.versionOf("m1")).toBe(6);
  });

  test("an add then a remove of the same emoji end removed, whichever answers first", async () => {
    for (const order of [
      ["add", "remove"],
      ["remove", "add"],
    ] as const) {
      const h = harness([message("m1", 1, [thumbs], 1)]);
      const add = gate<VersionedReactions>();
      const remove = gate<VersionedReactions>();
      const added = h.sync.toggle("m1", "👍", dev, true, () => add.promise);
      const removed = h.sync.toggle("m1", "👍", dev, false, () => remove.promise);
      expect(h.reactionsOf("m1")).toEqual([thumbs]);
      const answers = {
        add: async () => {
          add.release({
            reactions: [{ emoji: "👍", count: 2, reactors: [jordan, dev] }],
            version: 2,
          });
          await added;
        },
        remove: async () => {
          remove.release({ reactions: [thumbs], version: 3 });
          await removed;
        },
      };
      for (const step of order) await answers[step]();
      expect(h.reactionsOf("m1")).toEqual([thumbs]);
      expect(h.versionOf("m1")).toBe(3);
    }
  });

  test("a failed click is no longer pending: what the server last said shows again", async () => {
    const h = harness([message("m1", 1, [thumbs], 1)]);
    const server = gate<VersionedReactions>();
    const done = h.sync.toggle("m1", "🎉", dev, true, () => server.promise);
    expect(h.reactionsOf("m1")).toEqual([thumbs, { emoji: "🎉", count: 1, reactors: [dev] }]);
    server.fail(new Error("offline"));
    await expect(done).rejects.toThrow("offline");
    expect(h.reactionsOf("m1")).toEqual([thumbs]);
    expect(h.resyncs()).toBe(1);
  });
});
