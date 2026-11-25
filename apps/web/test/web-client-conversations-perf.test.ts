import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  clearComposerDraft,
  composerDraftKey,
  subscribeComposerDrafts,
  taskDraftKey,
  writeComposerDraft,
} from "#src/features/conversations/composer-draft";
import {
  hasConversationDraft,
  subscribeConversationDraft,
} from "#src/features/conversations/composer-drafts-index";
import {
  MAX_VISITED_THREADS,
  rememberVisitedThread,
} from "#src/features/conversations/use-conversation-sync";
import { arrivedThreadRootIds } from "#src/features/conversations/use-conversation-data";

describe("web-client conversation memory and keystroke optimizations", () => {
  test("rememberVisitedThread caps visited ThreadPanes with LRU eviction and stable MRU identity", () => {
    expect(MAX_VISITED_THREADS).toBe(5);
    expect(rememberVisitedThread(["t-1"], "t-2", 0)).toEqual([]);
    let visited: string[] = [];
    for (let i = 1; i <= 7; i++) {
      visited = rememberVisitedThread(visited, `t-${i}`);
    }
    expect(visited).toEqual(["t-3", "t-4", "t-5", "t-6", "t-7"]);

    const same = rememberVisitedThread(visited, "t-7");
    expect(same).toBe(visited);

    const promoted = rememberVisitedThread(visited, "t-3");
    expect(promoted).toEqual(["t-4", "t-5", "t-6", "t-7", "t-3"]);

    const evicted = rememberVisitedThread(promoted, "t-8");
    expect(evicted).toEqual(["t-5", "t-6", "t-7", "t-3", "t-8"]);
  });

  test("arrivedThreadRootIds extracts thread reply roots and agent unfollow notice roots", () => {
    expect(arrivedThreadRootIds([])).toEqual([]);
    expect(arrivedThreadRootIds([{ threadRootId: null }, {}])).toEqual([]);
    expect(
      arrivedThreadRootIds([
        { threadRootId: null },
        { threadRootId: "root-a" },
        { threadRootId: "root-b" },
        { threadRootId: "root-a" },
        {
          threadRootId: null,
          system: {
            kind: "channel.agent_thread_unfollowed",
            params: { agentId: "agent-1", rootMessageId: "root-unfollowed" },
          },
        },
        {
          threadRootId: null,
          system: { kind: "channel.other_notice", params: { rootMessageId: "ignored" } },
        },
      ]),
    ).toEqual(["root-a", "root-b", "root-unfollowed"]);
  });

  describe("keyed conversation draft subscriptions", () => {
    let items: Map<string, string>;
    let storageHandlers: Set<(event: { key: string | null }) => void>;
    const hadStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const hadWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

    beforeEach(() => {
      items = new Map();
      storageHandlers = new Set();
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: {
          getItem: (key: string) => items.get(key) ?? null,
          setItem: (key: string, value: string) => void items.set(key, value),
          removeItem: (key: string) => void items.delete(key),
          get length() {
            return items.size;
          },
          key: (index: number) => [...items.keys()][index] ?? null,
        },
      });
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: {
          addEventListener: (type: string, fn: (event: { key: string | null }) => void) => {
            if (type === "storage") storageHandlers.add(fn);
          },
          removeEventListener: (type: string, fn: (event: { key: string | null }) => void) => {
            if (type === "storage") storageHandlers.delete(fn);
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

    test("notifies only the target conversation when presence flips and manages the storage bridge", () => {
      let aCount = 0;
      let bCount = 0;
      const unsubA = subscribeConversationDraft("conv-a", () => void aCount++);
      const unsubB = subscribeConversationDraft("conv-b", () => void bCount++);
      expect(storageHandlers.size).toBe(1);

      expect(hasConversationDraft("conv-a")).toBe(false);
      expect(hasConversationDraft("conv-b")).toBe(false);

      writeComposerDraft(composerDraftKey("conv-a"), "h", 1);
      expect(hasConversationDraft("conv-a")).toBe(true);
      expect(aCount).toBe(1);
      expect(bCount).toBe(0);

      writeComposerDraft(composerDraftKey("conv-a"), "he", 2);
      writeComposerDraft(composerDraftKey("conv-a"), "hel", 3);
      expect(aCount).toBe(1);
      expect(bCount).toBe(0);

      writeComposerDraft(taskDraftKey("conv-b", 1), "task draft", 4);
      expect(hasConversationDraft("conv-b")).toBe(false);
      expect(bCount).toBe(0);

      writeComposerDraft(composerDraftKey("conv-a", "root-1"), "thread reply", 5);
      expect(hasConversationDraft("conv-a")).toBe(true);
      expect(aCount).toBe(1);

      clearComposerDraft(composerDraftKey("conv-a"));
      expect(hasConversationDraft("conv-a")).toBe(true);
      expect(aCount).toBe(1);

      clearComposerDraft(composerDraftKey("conv-a", "root-1"));
      expect(hasConversationDraft("conv-a")).toBe(false);
      expect(aCount).toBe(2);

      items.set(composerDraftKey("conv-b"), "from other tab");
      for (const handler of storageHandlers) handler({ key: composerDraftKey("conv-b") });
      expect(hasConversationDraft("conv-b")).toBe(true);
      expect(bCount).toBe(1);
      expect(aCount).toBe(2);

      items.clear();
      for (const handler of storageHandlers) handler({ key: null });
      expect(hasConversationDraft("conv-b")).toBe(false);
      expect(bCount).toBe(2);
      expect(aCount).toBe(3);

      unsubA();
      expect(storageHandlers.size).toBe(1);
      unsubB();
      expect(storageHandlers.size).toBe(0);
    });

    test("duplicate listener registration with out-of-order unsubscribe detaches the storage bridge cleanly", () => {
      const sameConvListener = () => {};
      const c1 = subscribeConversationDraft("conv-dup", sameConvListener);
      const c2 = subscribeConversationDraft("conv-dup", sameConvListener);
      expect(storageHandlers.size).toBe(1);
      c2();
      c1();
      expect(storageHandlers.size).toBe(0);

      const sameGlobalListener = () => {};
      const g1 = subscribeComposerDrafts(sameGlobalListener);
      const g2 = subscribeComposerDrafts(sameGlobalListener);
      expect(storageHandlers.size).toBe(1);
      g2();
      g1();
      expect(storageHandlers.size).toBe(0);
    });
  });
});
