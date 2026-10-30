import { describe, expect, test } from "bun:test";

import { chatSectionOrderQuery } from "#src/features/conversations/chat-sections";
import { AppError } from "#src/lib/app-error";
import { sectionApi, sidebarWith } from "./helpers/sidebar-fake";

/** The sidebar's sections and the changes made to them, against fake server calls: each change
 * shows at once, is saved, and stays as shown, is retried, or goes back. */

test("moving a pinned DM shows its section immediately and rolls back both changes on failure", async () => {
  const gate = Promise.withResolvers<void>();
  const { sidebar } = await sidebarWith({ sections: { ...sectionApi, move: () => gate.promise } });
  await sidebar.sections.preload();
  await sidebar.actions.close({ kind: "direct", conversationId: "dm-helper" });
  const saving = sidebar.actions.moveToSection(
    { kind: "direct", conversationId: "dm-helper" },
    "section-a",
  );
  try {
    expect(sidebar.directs.get("dm-helper")?.pinned).toBe(false);
    expect(sidebar.directs.get("dm-helper")?.hidden).toBe(false);
    expect(sidebar.sections.get("section-a")?.conversationIds).toEqual(["dm-helper"]);
  } finally {
    gate.reject(new Error("offline"));
    await expect(saving).rejects.toThrow("offline");
  }
  expect(sidebar.directs.get("dm-helper")?.pinned).toBe(true);
  expect(sidebar.sections.get("section-a")?.conversationIds).toEqual([]);
});

test("a section reorder and an insertion before another conversation show immediately and stay saved", async () => {
  const { sidebar } = await sidebarWith({
    sections: {
      ...sectionApi,
      list: async () => [
        {
          id: "section-a",
          name: "First",
          emoji: null,
          collapsed: false,
          sortOrder: 0,
          sortMode: "manual" as const,
          conversationIds: ["general"],
        },
        {
          id: "section-b",
          name: "Second",
          emoji: null,
          collapsed: false,
          sortOrder: 1,
          sortMode: "manual" as const,
          conversationIds: [],
        },
      ],
    },
  });
  await sidebar.sections.preload();
  const order = () =>
    [...sidebar.sections.toArray]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((section) => section.id);
  const ordering = sidebar.actions.reorderSections(["section-b", "section-a"]);
  expect(order()).toEqual(["section-b", "section-a"]);
  await ordering;
  const moving = sidebar.actions.moveToSection(
    { kind: "direct", conversationId: "dm-helper" },
    "section-a",
    "general",
  );
  expect(sidebar.sections.get("section-a")?.conversationIds).toEqual(["dm-helper", "general"]);
  await moving;
  expect(order()).toEqual(["section-b", "section-a"]);
  expect(sidebar.sections.get("section-a")?.conversationIds).toEqual(["dm-helper", "general"]);
});

test("a failed section drag puts the default order back when the saved order was never read", async () => {
  const { sidebar, queryClient } = await sidebarWith({
    sections: {
      ...sectionApi,
      reorder: async () => {
        throw new Error("offline");
      },
    },
  });
  await sidebar.sections.preload();
  const orderKey = chatSectionOrderQuery("w").queryKey;
  expect(queryClient.getQueryData<string[]>(orderKey)).toBeUndefined();
  const ordering = sidebar.actions.reorderSections(["agents", "channels", "pinned", "section-a"]);
  expect(queryClient.getQueryData<string[]>(orderKey)).toEqual([
    "agents",
    "channels",
    "pinned",
    "section-a",
  ]);
  await expect(ordering).rejects.toThrow("offline");
  // `[]` is the default order the sidebar showed before the drag.
  expect(queryClient.getQueryData<string[]>(orderKey)).toEqual([]);
});

test("an order read in flight when a section is dropped does not put the old order back", async () => {
  const read = Promise.withResolvers<string[]>();
  const { sidebar, queryClient } = await sidebarWith();
  await sidebar.sections.preload();
  const orderKey = chatSectionOrderQuery("w").queryKey;
  // The old order, still on its way from the server when the drop happens.
  const reading = queryClient
    .fetchQuery(chatSectionOrderQuery("w", { ...sectionApi, order: () => read.promise }))
    .catch(() => undefined);
  const ordering = sidebar.actions.reorderSections(["channels", "pinned", "section-a"]);
  read.resolve(["pinned", "section-a", "channels"]);
  await reading;
  expect(queryClient.getQueryData<string[]>(orderKey)).toEqual(["channels", "pinned", "section-a"]);
  await ordering;
  expect(queryClient.getQueryData<string[]>(orderKey)).toEqual(["channels", "pinned", "section-a"]);
});

test("an order read that answers during the save does not outlive it", async () => {
  const save = Promise.withResolvers<void>();
  const { sidebar, queryClient } = await sidebarWith({
    sections: { ...sectionApi, reorder: () => save.promise },
  });
  await sidebar.sections.preload();
  const orderKey = chatSectionOrderQuery("w").queryKey;
  const ordering = sidebar.actions.reorderSections(["channels", "pinned", "section-a"]);
  // A refetch sent after the drop reaches the server before the save does.
  await queryClient.fetchQuery(
    chatSectionOrderQuery("w", { ...sectionApi, order: async () => ["pinned", "channels"] }),
  );
  save.resolve();
  await ordering;
  expect(queryClient.getQueryData<string[]>(orderKey)).toEqual(["channels", "pinned", "section-a"]);
});

describe("a section change whose save fails", () => {
  const helper = { kind: "direct", conversationId: "dm-helper" } as const;

  test("is retried in the background and stays where it was dropped", async () => {
    let calls = 0;
    const secondCall = Promise.withResolvers<void>();
    const retried = Promise.withResolvers<void>();
    const { sidebar } = await sidebarWith(
      {
        sections: {
          ...sectionApi,
          move: async () => {
            calls += 1;
            if (calls === 1) throw new Error("offline");
            secondCall.resolve();
            await retried.promise;
          },
        },
      },
      { saveRetryDelaysMs: [0] },
    );
    await sidebar.sections.preload();
    const counts: number[] = [];
    const stop = sidebar.savesRetrying.subscribe(() => counts.push(sidebar.savesRetrying.count()));
    const saving = sidebar.actions.moveToSection(helper, "section-a");
    try {
      await secondCall.promise;
      expect(calls).toBe(2);
      expect(sidebar.savesRetrying.count()).toBe(1);
      expect(sidebar.sections.get("section-a")?.conversationIds).toEqual(["dm-helper"]);
    } finally {
      retried.resolve();
      await saving;
      stop();
    }
    expect(sidebar.sections.get("section-a")?.conversationIds).toEqual(["dm-helper"]);
    expect(sidebar.savesRetrying.count()).toBe(0);
    expect(counts).toEqual([1, 0]);
  });

  test("that the server refuses is not retried, and rolls back", async () => {
    let calls = 0;
    const { sidebar } = await sidebarWith(
      {
        sections: {
          ...sectionApi,
          move: async () => {
            calls += 1;
            throw new AppError("NOT_FOUND");
          },
        },
      },
      { saveRetryDelaysMs: [0, 0] },
    );
    await sidebar.sections.preload();
    await expect(sidebar.actions.moveToSection(helper, "section-a")).rejects.toThrow();
    expect(calls).toBe(1);
    expect(sidebar.sections.get("section-a")?.conversationIds).toEqual([]);
  });

  test("waiting to be retried gives way to a newer move of the same conversation", async () => {
    const moves: Array<string | null> = [];
    const waiting = Promise.withResolvers<void>();
    const retryDue = Promise.withResolvers<void>();
    const { sidebar } = await sidebarWith(
      {
        sections: {
          ...sectionApi,
          list: async () => [
            { ...(await sectionApi.list())[0]!, id: "section-a" },
            { ...(await sectionApi.list())[0]!, id: "section-b", sortOrder: 1 },
          ],
          move: async (_conversationId, sectionId) => {
            moves.push(sectionId);
            if (sectionId === "section-a") throw new Error("offline");
          },
        },
      },
      {
        saveRetryDelaysMs: [0],
        sleep: () => {
          waiting.resolve();
          return retryDue.promise;
        },
      },
    );
    await sidebar.sections.preload();
    const toA = sidebar.actions.moveToSection(helper, "section-a");
    await waiting.promise;
    await sidebar.actions.moveToSection(helper, "section-b");
    retryDue.resolve();
    await toA;

    expect(moves).toEqual(["section-a", "section-b"]);
    expect(sidebar.sections.get("section-a")?.conversationIds).toEqual([]);
    expect(sidebar.sections.get("section-b")?.conversationIds).toEqual(["dm-helper"]);
    expect(sidebar.savesRetrying.count()).toBe(0);
  });

  test("that keeps failing rolls back once its retries are spent", async () => {
    let calls = 0;
    const { sidebar } = await sidebarWith(
      {
        sections: {
          ...sectionApi,
          move: async () => {
            calls += 1;
            throw new Error("offline");
          },
        },
      },
      { saveRetryDelaysMs: [0, 0] },
    );
    await sidebar.sections.preload();
    await expect(sidebar.actions.moveToSection(helper, "section-a")).rejects.toThrow("offline");
    expect(calls).toBe(3);
    expect(sidebar.sections.get("section-a")?.conversationIds).toEqual([]);
    expect(sidebar.savesRetrying.count()).toBe(0);
  });
});
