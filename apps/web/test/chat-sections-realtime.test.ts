import { expect, test } from "bun:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";

import type { ChatSection } from "#src/features/conversations/chat-section.schemas";
import type { ChatListRead } from "#src/features/conversations/chat-list-reads";
import { createChatListReader } from "#src/features/conversations/chat-lists-reader";
import {
  chatSectionOrderQuery,
  chatSectionsQuery,
  type ChatSectionsApi,
} from "#src/features/conversations/chat-sections";
import { decodeViewerEvent } from "#src/features/conversations/conversation-realtime";
import { sidebarListsChangedBy } from "#src/features/conversations/conversation-unread";
import { chatListQueryKey } from "#src/features/conversations/sidebar-queries";

const unused = async () => {
  throw new Error("not called");
};

const focus: ChatSection = {
  id: "section-focus",
  name: "Focus",
  emoji: null,
  collapsed: false,
  sortOrder: 0,
  sortMode: "manual",
  conversationIds: [],
};

/** Settles once `observer` holds a read that is not under way. */
function settled(observer: {
  getCurrentResult: () => { isSuccess: boolean; fetchStatus: string };
  subscribe: (listener: () => void) => () => void;
}) {
  return new Promise<void>((resolve) => {
    const check = () => {
      const result = observer.getCurrentResult();
      if (result.isSuccess && result.fetchStatus === "idle") {
        unsubscribe();
        resolve();
      }
    };
    const unsubscribe = observer.subscribe(check);
    check();
  });
}

test("a section made on another device shows here once its announcement arrives, sections and order read in one call", async () => {
  // What the server holds, which the other device changes.
  let held = { sections: [] as ChatSection[], order: [] as string[] };
  const calls: ChatListRead[][] = [];
  const read = createChatListReader(async (lists) => {
    calls.push(lists);
    const answers = {
      sections: { value: { streamPositions: {}, sections: held.sections } },
      sectionOrder: { value: { streamPositions: {}, order: held.order } },
    };
    return Object.fromEntries(lists.map((list) => [list, answers[list as keyof typeof answers]]));
  });
  const api: ChatSectionsApi = {
    list: () => read("sections"),
    order: () => read("sectionOrder"),
    create: unused,
    update: unused,
    remove: unused,
    reorder: unused,
    move: unused,
  };
  // This device's sidebar shows the sections and their order.
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const sections = new QueryObserver(queryClient, chatSectionsQuery("w", api));
  const order = new QueryObserver(queryClient, chatSectionOrderQuery("w", api));
  const shown = [sections.subscribe(() => {}), order.subscribe(() => {})];
  await Promise.all([settled(sections), settled(order)]);
  expect(calls).toEqual([["sections", "sectionOrder"]]);

  // The other device makes a section and drags it first; the server announces the change on the
  // member's own channel, which this page hears.
  held = { sections: [focus], order: [focus.id, "channels"] };
  const event = decodeViewerEvent({ type: "pref.changed.v1", workspaceId: "w", name: "sections" });
  // What the page does with a stale list (`useRefreshSidebar`).
  await Promise.all(
    sidebarListsChangedBy(event!).map((list) =>
      queryClient.invalidateQueries({ queryKey: chatListQueryKey[list]("w") }),
    ),
  );

  expect(sections.getCurrentResult().data?.sections).toEqual([focus]);
  expect(order.getCurrentResult().data?.order).toEqual([focus.id, "channels"]);
  expect(calls).toEqual([
    ["sections", "sectionOrder"],
    ["sections", "sectionOrder"],
  ]);
  for (const stop of shown) stop();
});
