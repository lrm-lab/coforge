import { describe, expect, test } from "bun:test";
import {
  createConversationListScrollMemory,
  isPhonePageScrollActive,
  type ConversationListScrollHost,
} from "../src/features/conversations/conversation-list-scroll";

function createMockHost(options: { pageScrollActive?: boolean; initialScrollY?: number } = {}) {
  let pageScrollActive = options.pageScrollActive ?? true;
  let scrollY = options.initialScrollY ?? 0;
  let containerScrollTop = 0;
  const scrollToCalls: ScrollToOptions[] = [];

  const host: ConversationListScrollHost = {
    scroller: {
      get scrollTop() {
        return containerScrollTop;
      },
      set scrollTop(value: number) {
        containerScrollTop = value;
      },
      closest(selector: string) {
        if (!pageScrollActive) return null;
        if (selector === "[data-phone-page-scroll]" || selector === "[data-phone-stack-root]") {
          return {} as Element;
        }
        return null;
      },
    },
    win: {
      get scrollY() {
        return scrollY;
      },
      scrollTo(next: ScrollToOptions) {
        scrollToCalls.push(next);
        if (typeof next.top === "number") scrollY = next.top;
      },
    },
  };

  return {
    host,
    scrollToCalls,
    setPageScrollActive: (active: boolean) => {
      pageScrollActive = active;
    },
    setScrollY: (value: number) => {
      scrollY = value;
    },
    getContainerScrollTop: () => containerScrollTop,
    setContainerScrollTop: (value: number) => {
      containerScrollTop = value;
    },
  };
}

describe("conversation list scroll restoration", () => {
  test("detects active phone page scroll only when both markers wrap the list scroller", () => {
    const both = createMockHost({ pageScrollActive: true });
    expect(isPhonePageScrollActive(both.host.scroller)).toBe(true);

    const missingRoot: ConversationListScrollHost["scroller"] = {
      scrollTop: 0,
      closest: (selector) => (selector === "[data-phone-page-scroll]" ? ({} as Element) : null),
    };
    expect(isPhonePageScrollActive(missingRoot)).toBe(false);
  });

  test("preserves window scroll position across opening a DM and returning on phone", () => {
    const env = createMockHost({ pageScrollActive: true });
    const memory = createConversationListScrollMemory();

    memory.syncLayout(env.host, { phone: true, showList: true, listVisible: true });
    memory.finishRestoreFlush(env.host, { phone: true, showList: true, listVisible: true });
    expect(memory.isAutoRevealSuppressed()).toBe(false);

    env.setScrollY(850);
    memory.recordScroll(env.host, { phone: true, showList: true, listVisible: true }, "window");
    expect(memory.getSavedScrollTop()).toBe(850);

    memory.captureBeforeLeave(env.host, { phone: true, showList: true, listVisible: true });

    env.setPageScrollActive(false);
    env.setScrollY(0);
    memory.recordScroll(env.host, { phone: true, showList: false, listVisible: true }, "window");
    memory.syncLayout(env.host, { phone: true, showList: false, listVisible: true });
    memory.syncLayout(env.host, { phone: true, showList: false, listVisible: false });
    expect(memory.getSavedScrollTop()).toBe(850);
    expect(env.getContainerScrollTop()).toBe(850);

    memory.syncLayout(env.host, { phone: true, showList: true, listVisible: false });
    expect(env.scrollToCalls).toEqual([]);

    env.setPageScrollActive(true);
    memory.syncLayout(env.host, { phone: true, showList: true, listVisible: true });
    expect(env.scrollToCalls).toEqual([{ top: 850, behavior: "instant" }]);
    expect(env.host.win.scrollY).toBe(850);
    expect(env.getContainerScrollTop()).toBe(0);
    expect(memory.isAutoRevealSuppressed()).toBe(true);

    memory.finishRestoreFlush(env.host, { phone: true, showList: true, listVisible: true });
    expect(memory.isAutoRevealSuppressed()).toBe(false);
  });

  test("keeps auto-reveal active when returning to the list for the first time from a direct DM URL", () => {
    const env = createMockHost({ pageScrollActive: false });
    const memory = createConversationListScrollMemory();

    memory.syncLayout(env.host, { phone: true, showList: false, listVisible: false });
    memory.finishRestoreFlush(env.host, { phone: true, showList: false, listVisible: false });
    expect(memory.getSavedScrollTop()).toBeNull();

    memory.syncLayout(env.host, { phone: true, showList: true, listVisible: false });
    env.setPageScrollActive(true);
    memory.syncLayout(env.host, { phone: true, showList: true, listVisible: true });

    expect(env.scrollToCalls).toEqual([]);
    expect(memory.isAutoRevealSuppressed()).toBe(false);

    env.setScrollY(640);
    memory.finishRestoreFlush(env.host, { phone: true, showList: true, listVisible: true });
    expect(memory.getSavedScrollTop()).toBe(640);
  });

  test("preserves zero scroll position after scrolling back to top", () => {
    const env = createMockHost({ pageScrollActive: true });
    const memory = createConversationListScrollMemory();

    memory.syncLayout(env.host, { phone: true, showList: true, listVisible: true });
    memory.finishRestoreFlush(env.host, { phone: true, showList: true, listVisible: true });

    env.setScrollY(500);
    memory.recordScroll(env.host, { phone: true, showList: true, listVisible: true }, "window");
    env.setScrollY(0);
    memory.recordScroll(env.host, { phone: true, showList: true, listVisible: true }, "window");

    memory.captureBeforeLeave(env.host, { phone: true, showList: true, listVisible: true });
    env.setPageScrollActive(false);
    memory.syncLayout(env.host, { phone: true, showList: false, listVisible: false });
    env.setPageScrollActive(true);
    env.setScrollY(300);
    memory.syncLayout(env.host, { phone: true, showList: true, listVisible: true });

    expect(env.host.win.scrollY).toBe(0);
    expect(memory.isAutoRevealSuppressed()).toBe(true);
  });

  test("ignores scroll-to-zero while a mobile page-flow overlay is active", () => {
    const env = createMockHost({ pageScrollActive: true, initialScrollY: 850 });
    const memory = createConversationListScrollMemory();

    memory.syncLayout(env.host, { phone: true, showList: true, listVisible: true });
    memory.finishRestoreFlush(env.host, { phone: true, showList: true, listVisible: true });
    expect(memory.getSavedScrollTop()).toBe(850);

    env.setScrollY(0);
    memory.recordScroll(
      env.host,
      { phone: true, showList: true, listVisible: true, pageFlowActive: true },
      "window",
    );
    expect(memory.getSavedScrollTop()).toBe(850);
  });

  test("saves and restores container scrollTop when phone page scroll is not active", () => {
    const env = createMockHost({ pageScrollActive: false });
    const memory = createConversationListScrollMemory();

    memory.syncLayout(env.host, { phone: true, showList: true, listVisible: true });
    memory.finishRestoreFlush(env.host, { phone: true, showList: true, listVisible: true });

    env.setContainerScrollTop(420);
    memory.recordScroll(env.host, { phone: true, showList: true, listVisible: true }, "container");
    memory.captureBeforeLeave(env.host, { phone: true, showList: true, listVisible: true });

    env.setContainerScrollTop(0);
    memory.syncLayout(env.host, { phone: true, showList: false, listVisible: false });
    expect(env.getContainerScrollTop()).toBe(420);

    env.setContainerScrollTop(12);
    memory.syncLayout(env.host, { phone: true, showList: true, listVisible: true });
    expect(env.getContainerScrollTop()).toBe(420);
    expect(env.scrollToCalls).toEqual([]);
    expect(memory.isAutoRevealSuppressed()).toBe(true);
  });

  test("restores saved scroll position even when leaving the list without closeList", () => {
    const env = createMockHost({ pageScrollActive: true });
    const memory = createConversationListScrollMemory();

    memory.syncLayout(env.host, { phone: true, showList: true, listVisible: true });
    memory.finishRestoreFlush(env.host, { phone: true, showList: true, listVisible: true });

    env.setScrollY(850);
    memory.recordScroll(env.host, { phone: true, showList: true, listVisible: true }, "window");

    env.setPageScrollActive(false);
    env.setScrollY(0);
    memory.syncLayout(env.host, { phone: true, showList: false, listVisible: false });

    env.setPageScrollActive(true);
    memory.syncLayout(env.host, { phone: true, showList: true, listVisible: true });
    expect(env.host.win.scrollY).toBe(850);
    expect(memory.isAutoRevealSuppressed()).toBe(true);
  });

  test("resets state on desktop and leaves desktop auto-reveal enabled", () => {
    const env = createMockHost({ pageScrollActive: true, initialScrollY: 850 });
    const memory = createConversationListScrollMemory();

    memory.syncLayout(env.host, { phone: true, showList: true, listVisible: true });
    memory.finishRestoreFlush(env.host, { phone: true, showList: true, listVisible: true });
    expect(memory.getSavedScrollTop()).toBe(850);

    memory.syncLayout(env.host, { phone: false, showList: true, listVisible: true });
    expect(memory.getSavedScrollTop()).toBeNull();
    expect(memory.isAutoRevealSuppressed()).toBe(false);
  });
});
