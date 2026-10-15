import { expect, test } from "bun:test";
import { chatSectionFields } from "#src/features/conversations/chat-section.schemas";
import {
  DEFAULT_SECTION_EMOJI,
  SECTION_EMOJIS,
} from "#src/features/conversations/chat-section-emoji-picker";

test("every mark the picker offers, and the default, is one the server accepts", () => {
  expect(SECTION_EMOJIS).toContain(DEFAULT_SECTION_EMOJI);
  expect(new Set(SECTION_EMOJIS).size).toBe(SECTION_EMOJIS.length);
  for (const emoji of SECTION_EMOJIS)
    expect(chatSectionFields.shape.emoji.safeParse(emoji).success).toBe(true);
});
