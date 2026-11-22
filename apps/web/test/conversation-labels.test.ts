import { describe, expect, test } from "bun:test";

import { replyCountLabel, withUnreadCount } from "#src/features/conversations/conversation-labels";
import { getLocale, setLocale } from "#src/paraglide/runtime";

describe("conversation labels", () => {
  test("formats reply and unread counts with locale-aware thousand separators", () => {
    const previous = getLocale();
    setLocale("en", { reload: false });
    try {
      expect(replyCountLabel(1)).toBe("1 reply");
      expect(replyCountLabel(42)).toBe("42 replies");
      expect(replyCountLabel(1284)).toBe("1,284 replies");
      expect(withUnreadCount("Reply in thread", 0)).toBe("Reply in thread");
      expect(withUnreadCount("Reply in thread", 1284)).toBe("Reply in thread, 1,284 unread");
    } finally {
      setLocale(previous, { reload: false });
    }
  });
});
