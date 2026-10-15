import { expect, test } from "bun:test";
import { chatSectionFields } from "#src/features/conversations/chat-section.schemas";

/**
 * The picker is emoji-picker-react now, so the marks it can produce are whatever a full emoji
 * set contains. The contract to guard is the server schema: any one-grapheme emoji — including
 * the folder the dialog starts new sections with — is accepted, and non-emoji strings are not.
 */
test("the section schema accepts one-grapheme emoji marks and rejects text", () => {
  expect(chatSectionFields.shape.emoji.safeParse("📁").success).toBe(true);
  expect(chatSectionFields.shape.emoji.safeParse("🚀").success).toBe(true);
  expect(chatSectionFields.shape.emoji.safeParse("❤️").success).toBe(true);
  expect(chatSectionFields.shape.emoji.safeParse("folder").success).toBe(false);
  expect(chatSectionFields.shape.emoji.safeParse("").success).toBe(false);
  expect(chatSectionFields.shape.emoji.safeParse(null).success).toBe(true);
});
