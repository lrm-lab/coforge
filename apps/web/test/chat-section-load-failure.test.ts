import { describe, expect, test } from "bun:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";

import {
  chatSectionsQuery,
  chatSectionsStatus,
  type ChatSectionsApi,
} from "#src/features/conversations/chat-sections";

const section = {
  id: "section-a",
  name: "Project",
  emoji: null,
  collapsed: false,
  sortOrder: 0,
  sortMode: "manual" as const,
  conversationIds: [] as string[],
};

const unused = async () => {
  throw new Error("not called");
};

function sectionsObserver(list: ChatSectionsApi["list"]) {
  const api: ChatSectionsApi = {
    list,
    order: async () => [],
    create: unused,
    update: unused,
    remove: unused,
    reorder: unused,
    move: unused,
  };
  return new QueryObserver(new QueryClient(), { ...chatSectionsQuery("w", api), retry: false });
}

/**
 * When the sidebar says its sections did not load: only when it has none to show. A re-read that
 * fails keeps the sections already shown, and the next one brings them up to date.
 */
describe("chatSectionsStatus", () => {
  test("stays ready when a re-read fails after the sections loaded", async () => {
    let fail = false;
    const sections = sectionsObserver(async () => {
      if (fail) throw new Error("re-read failed");
      return [section];
    });
    await sections.refetch();
    fail = true;
    await sections.refetch();

    expect(sections.getCurrentResult().isError).toBe(true);
    expect(sections.getCurrentResult().data).toEqual([section]);
    expect(chatSectionsStatus(sections.getCurrentResult())).toBe("ready");
  });

  test("is failed when the sections never loaded", async () => {
    const sections = sectionsObserver(async () => {
      throw new Error("first read failed");
    });
    await sections.refetch();

    expect(chatSectionsStatus(sections.getCurrentResult())).toBe("failed");
  });

  test("is loading before the first read settles", () => {
    const sections = sectionsObserver(async () => [section]);

    expect(chatSectionsStatus(sections.getCurrentResult())).toBe("loading");
  });
});
