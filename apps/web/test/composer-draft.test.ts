import { afterEach, beforeEach, expect, test } from "bun:test";

import {
  attachmentCommentDraftKey,
  clearComposerDraft,
  composerDraftKey,
  placeOfDraftKey,
  readComposerDraft,
  readComposerDraftPins,
  stampKey,
  subscribeComposerDrafts,
  taskDraftKey,
  writeComposerDraft,
  writeComposerDraftPins,
} from "#src/features/conversations/composer-draft";
import {
  deviceDrafts,
  listComposerDrafts,
} from "#src/features/conversations/composer-drafts-index";
import type { MentionPin } from "#src/features/conversations/mention-pins";

const ZHANG: MentionPin = { kind: "user", id: "u-zhang", handle: "zhangsan", label: "张三" };
const SCOUT: MentionPin = { kind: "agent", id: "a-scout", handle: "scout", label: "小侦察" };

let items: Map<string, string>;
/** The keys `getItem` was asked for, and how many times `key(index)` walked the storage. */
let reads: string[];
let scans: number;
/** Playing a full storage: writing an edit-time entry throws. */
let stampsFail: boolean;
const hadStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const hadWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

/** A `window` that records its `storage` listeners, so a test can see when the bridge is attached
 * and play another tab's write. */
function fakeWindow() {
  const handlers = new Set<(event: { key: string | null }) => void>();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      addEventListener: (type: string, handler: (event: { key: string | null }) => void) => {
        if (type === "storage") handlers.add(handler);
      },
      removeEventListener: (type: string, handler: (event: { key: string | null }) => void) => {
        if (type === "storage") handlers.delete(handler);
      },
    },
  });
  return {
    handlers,
    /** Another tab changed `key` (`null`: it cleared storage). */
    storage: (key: string | null) => {
      for (const handler of handlers) handler({ key });
    },
  };
}

beforeEach(() => {
  items = new Map();
  reads = [];
  scans = 0;
  stampsFail = false;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => {
        reads.push(key);
        return items.get(key) ?? null;
      },
      setItem: (key: string, value: string) => {
        if (stampsFail && key.endsWith(":at")) throw new Error("QuotaExceededError");
        items.set(key, value);
      },
      removeItem: (key: string) => void items.delete(key),
      get length() {
        return items.size;
      },
      key: (index: number) => {
        scans++;
        return [...items.keys()][index] ?? null;
      },
    },
  });
});

afterEach(() => {
  if (hadWindow) Object.defineProperty(globalThis, "window", hadWindow);
  else Reflect.deleteProperty(globalThis, "window");
  if (hadStorage) Object.defineProperty(globalThis, "localStorage", hadStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

test("a draft's mention pins are remembered beside its text, per chat and per thread", () => {
  const main = composerDraftKey("chat-a");
  const thread = composerDraftKey("chat-a", "root-1");
  writeComposerDraft(main, "你好 @张三");
  writeComposerDraftPins(main, [ZHANG, SCOUT]);
  expect(readComposerDraft(main)).toBe("你好 @张三");
  expect(readComposerDraftPins(main)).toEqual([ZHANG, SCOUT]);
  expect(readComposerDraftPins(thread)).toEqual([]);
  expect(readComposerDraftPins(composerDraftKey("chat-b"))).toEqual([]);
});

test("a draft written before pins existed reads as text with none", () => {
  const key = composerDraftKey("chat-a");
  items.set(key, "plain text");
  expect(readComposerDraft(key)).toBe("plain text");
  expect(readComposerDraftPins(key)).toEqual([]);
});

test("no pins removes the entry, so a chat without them leaves nothing behind", () => {
  const key = composerDraftKey("chat-a");
  writeComposerDraftPins(key, [ZHANG]);
  writeComposerDraftPins(key, []);
  expect(items.size).toBe(0);
});

test("clearing a draft, as a send does, clears its pins too", () => {
  const key = composerDraftKey("chat-a");
  writeComposerDraft(key, "@张三");
  writeComposerDraftPins(key, [ZHANG]);
  clearComposerDraft(key);
  expect(items.size).toBe(0);
});

test("pins that cannot be read are dropped, and the text is unaffected", () => {
  const key = composerDraftKey("chat-a");
  writeComposerDraft(key, "@张三");
  writeComposerDraftPins(key, [ZHANG]);
  const pinsKey = `${key}:pins`;
  items.set(pinsKey, "{not json");
  expect(readComposerDraftPins(key)).toEqual([]);
  items.set(pinsKey, JSON.stringify([{ kind: "user", id: 7 }]));
  expect(readComposerDraftPins(key)).toEqual([]);
  expect(readComposerDraft(key)).toBe("@张三");
});

test("a draft is stamped when its text changes, not when the same text is written again", () => {
  const key = composerDraftKey("chat-a");
  writeComposerDraft(key, "first", 1_000);
  writeComposerDraft(key, "first", 2_000);
  expect(listComposerDrafts()[0]?.updatedAt).toBe(1_000);
  writeComposerDraft(key, "first, then more", 3_000);
  expect(listComposerDrafts()[0]?.updatedAt).toBe(3_000);
});

test("a blank body, like a send, takes the draft and its stamp away", () => {
  const key = composerDraftKey("chat-a");
  writeComposerDraft(key, "text", 1_000);
  writeComposerDraft(key, "", 2_000);
  expect(items.size).toBe(0);
  writeComposerDraft(key, "text again", 3_000);
  clearComposerDraft(key);
  expect(items.size).toBe(0);
});

test("the device's drafts are listed with where each was written, newest edit first", () => {
  writeComposerDraft(composerDraftKey("chat-a"), "in a channel", 1_000);
  writeComposerDraft(composerDraftKey("chat-a", "root-1"), "in a thread", 3_000);
  writeComposerDraft(taskDraftKey("board-1", 7), "on a task", 2_000);
  expect(listComposerDrafts()).toEqual([
    {
      key: composerDraftKey("chat-a", "root-1"),
      place: { conversationId: "chat-a", target: { kind: "thread", threadRootId: "root-1" } },
      body: "in a thread",
      updatedAt: 3_000,
    },
    {
      key: taskDraftKey("board-1", 7),
      place: { conversationId: "board-1", target: { kind: "task", number: 7 } },
      body: "on a task",
      updatedAt: 2_000,
    },
    {
      key: composerDraftKey("chat-a"),
      place: { conversationId: "chat-a", target: { kind: "conversation" } },
      body: "in a channel",
      updatedAt: 1_000,
    },
  ]);
});

test("a draft with no stamp follows the stamped ones, in key order", () => {
  items.set(composerDraftKey("chat-b"), "old b");
  items.set(composerDraftKey("chat-a"), "old a");
  writeComposerDraft(composerDraftKey("chat-c"), "new", 5);
  expect(listComposerDrafts().map((draft) => [draft.place, draft.updatedAt])).toEqual([
    [{ conversationId: "chat-c", target: { kind: "conversation" } }, 5],
    [{ conversationId: "chat-a", target: { kind: "conversation" } }, null],
    [{ conversationId: "chat-b", target: { kind: "conversation" } }, null],
  ]);
});

test("a key names the place its draft was written, and a place's key reads back as it", () => {
  expect(placeOfDraftKey(composerDraftKey("chat-a"))).toEqual({
    conversationId: "chat-a",
    target: { kind: "conversation" },
  });
  expect(placeOfDraftKey(composerDraftKey("chat-a", "root-1"))).toEqual({
    conversationId: "chat-a",
    target: { kind: "thread", threadRootId: "root-1" },
  });
  expect(placeOfDraftKey(taskDraftKey("board-1", 7))).toEqual({
    conversationId: "board-1",
    target: { kind: "task", number: 7 },
  });
});

test("a Task's draft key is the chat key of `task:<board>:<number>`, as it has always been stored", () => {
  expect(taskDraftKey("board-1", 7)).toBe(composerDraftKey("task:board-1:7"));
  expect(taskDraftKey("board-1", 7)).toBe("coforge.composer-draft:task:board-1:7");
});

test("pins, stamps, file comments, blank text and other keys are not drafts", () => {
  const key = composerDraftKey("chat-a");
  writeComposerDraft(key, "kept", 1);
  writeComposerDraftPins(key, [ZHANG]);
  writeComposerDraft(attachmentCommentDraftKey("file-1"), "a comment", 2);
  writeComposerDraft(composerDraftKey("chat-b"), "  \n ", 3);
  writeComposerDraft(taskDraftKey("board-1", 7), "a task", 4);
  writeComposerDraftPins(taskDraftKey("board-1", 7), [ZHANG]);
  items.set("coforge.composer-outbox:abc", "{}");
  items.set("unrelated", "x");
  expect(listComposerDrafts().map((draft) => draft.body)).toEqual(["a task", "kept"]);
  for (const sibling of [`${key}:pins`, `${key}:at`, `${taskDraftKey("board-1", 7)}:pins`])
    expect(placeOfDraftKey(sibling)).toBeUndefined();
  expect(placeOfDraftKey(attachmentCommentDraftKey("file-1"))).toBeUndefined();
  expect(placeOfDraftKey(`${composerDraftKey("chat-a", "root-1")}:at`)).toBeUndefined();
  expect(placeOfDraftKey("coforge.composer-draft:")).toBeUndefined();
  expect(placeOfDraftKey("coforge.composer-draft:task:board-1:x")).toBeUndefined();
});

test("a write tells subscribers once, and the snapshot is the same list until something changes", () => {
  const key = composerDraftKey("chat-a");
  let told = 0;
  const unsubscribe = subscribeComposerDrafts(() => void told++);
  writeComposerDraft(key, "hello", 1);
  expect(told).toBe(1);
  const first = deviceDrafts();
  expect(deviceDrafts()).toBe(first);
  writeComposerDraft(key, "hello", 2);
  expect(told).toBe(1);
  expect(deviceDrafts()).toBe(first);
  writeComposerDraft(key, "hello!", 3);
  expect(told).toBe(2);
  expect(deviceDrafts()).not.toBe(first);
  clearComposerDraft(key);
  expect(told).toBe(3);
  expect(deviceDrafts()).toEqual([]);
  clearComposerDraft(key);
  expect(told).toBe(3);
  unsubscribe();
  writeComposerDraft(key, "again", 4);
  expect(told).toBe(3);
  expect(deviceDrafts().map((draft) => draft.body)).toEqual(["again"]);
});

test("a file comment's draft and a draft's pins tell nobody", () => {
  const key = composerDraftKey("chat-a");
  let told = 0;
  const unsubscribe = subscribeComposerDrafts(() => void told++);
  writeComposerDraft(attachmentCommentDraftKey("file-1"), "a comment", 1);
  writeComposerDraft(attachmentCommentDraftKey("file-1"), "", 2);
  writeComposerDraftPins(key, [ZHANG]);
  clearComposerDraft(attachmentCommentDraftKey("file-1"));
  expect(told).toBe(0);
  unsubscribe();
});

test("another tab's draft change reaches subscribers, other storage keys do not", () => {
  const tab = fakeWindow();
  let told = 0;
  const unsubscribe = subscribeComposerDrafts(() => void told++);
  const before = deviceDrafts();
  for (const other of [
    "unrelated",
    attachmentCommentDraftKey("file-1"),
    `${composerDraftKey("chat-a")}:pins`,
    `${composerDraftKey("chat-a")}:at`,
  ])
    tab.storage(other);
  expect(told).toBe(0);
  expect(deviceDrafts()).toBe(before);
  items.set(composerDraftKey("chat-a"), "from another tab");
  tab.storage(composerDraftKey("chat-a"));
  expect(told).toBe(1);
  expect(deviceDrafts().map((draft) => draft.body)).toEqual(["from another tab"]);
  tab.storage(null);
  expect(told).toBe(2);
  unsubscribe();
});

test("the storage bridge is attached while someone subscribes, and only then", () => {
  const tab = fakeWindow();
  expect(tab.handlers.size).toBe(0);
  const first = subscribeComposerDrafts(() => {});
  const second = subscribeComposerDrafts(() => {});
  expect(tab.handlers.size).toBe(1);
  first();
  expect(tab.handlers.size).toBe(1);
  second();
  expect(tab.handlers.size).toBe(0);
});

test("a draft another tab changed while nobody listened is read once someone subscribes", () => {
  fakeWindow();
  const first = subscribeComposerDrafts(() => {});
  expect(deviceDrafts()).toEqual([]);
  first();
  items.set(composerDraftKey("chat-a"), "written in another tab, unheard");
  const second = subscribeComposerDrafts(() => {});
  expect(deviceDrafts().map((draft) => draft.body)).toEqual(["written in another tab, unheard"]);
  second();
});

test("a change to one draft reads that draft alone and keeps the list sorted, as a new list", () => {
  const [a, b, c] = ["chat-a", "chat-b", "chat-c"].map((id) => composerDraftKey(id));
  writeComposerDraft(a!, "a", 3_000);
  writeComposerDraft(b!, "b", 2_000);
  writeComposerDraft(c!, "c", 1_000);
  const unsubscribe = subscribeComposerDrafts(() => {});
  const before = deviceDrafts();
  expect(before.map((draft) => draft.body)).toEqual(["a", "b", "c"]);
  reads = [];
  scans = 0;

  writeComposerDraft(c!, "c, edited", 4_000);
  const edited = deviceDrafts();
  expect(edited).not.toBe(before);
  expect(edited.map((draft) => [draft.body, draft.updatedAt])).toEqual([
    ["c, edited", 4_000],
    ["a", 3_000],
    ["b", 2_000],
  ]);
  expect(deviceDrafts()).toBe(edited);
  expect(before.map((draft) => draft.body)).toEqual(["a", "b", "c"]);

  const added = composerDraftKey("chat-d", "root-1");
  writeComposerDraft(added, "d", 2_500);
  expect(deviceDrafts().map((draft) => draft.body)).toEqual(["c, edited", "a", "d", "b"]);

  clearComposerDraft(a!);
  expect(deviceDrafts().map((draft) => draft.body)).toEqual(["c, edited", "d", "b"]);

  expect(new Set(reads)).toEqual(new Set([c!, stampKey(c!), added, stampKey(added), a!]));
  expect(scans).toBe(0);
  unsubscribe();
});

test("a change heard from another tab for one key reads that key alone", () => {
  const tab = fakeWindow();
  const a = composerDraftKey("chat-a");
  const b = composerDraftKey("chat-b");
  items.set(a, "old a");
  items.set(b, "old b");
  const unsubscribe = subscribeComposerDrafts(() => {});
  expect(deviceDrafts().map((draft) => draft.key)).toEqual([a, b]);
  reads = [];
  scans = 0;
  items.set(b, "new b");
  items.set(stampKey(b), "9");
  tab.storage(b);
  expect(deviceDrafts().map((draft) => [draft.body, draft.updatedAt])).toEqual([
    ["new b", 9],
    ["old a", null],
  ]);
  items.delete(a);
  tab.storage(a);
  expect(deviceDrafts().map((draft) => draft.body)).toEqual(["new b"]);
  expect(new Set(reads)).toEqual(new Set([a, b, stampKey(b)]));
  expect(scans).toBe(0);
  unsubscribe();
});

test("a change of unknown extent, such as storage cleared in another tab, reads everything again", () => {
  const tab = fakeWindow();
  items.set(composerDraftKey("chat-a"), "a");
  const unsubscribe = subscribeComposerDrafts(() => {});
  expect(deviceDrafts()).toHaveLength(1);
  items.set(composerDraftKey("chat-b"), "b");
  items.delete(composerDraftKey("chat-a"));
  tab.storage(null);
  scans = 0;
  expect(deviceDrafts().map((draft) => draft.body)).toEqual(["b"]);
  expect(scans).toBeGreaterThan(0);
  unsubscribe();
});

test("subscribers hear of a draft's text even when its edit time cannot be saved", () => {
  const key = composerDraftKey("chat-a");
  let told = 0;
  const unsubscribe = subscribeComposerDrafts(() => void told++);
  stampsFail = true;
  writeComposerDraft(key, "typed", 1);
  expect(told).toBe(1);
  expect(readComposerDraft(key)).toBe("typed");
  expect(deviceDrafts().map((draft) => [draft.body, draft.updatedAt])).toEqual([["typed", null]]);
  unsubscribe();
});
