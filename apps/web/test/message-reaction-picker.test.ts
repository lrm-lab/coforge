import { expect, test } from "bun:test";
import { isValidReactionEmoji } from "@lrm/coforge-sdk/internal";
import { toggleMessageReactionInputSchema } from "#src/features/conversations/conversation.schemas";
import { QUICK_REACTION_EMOJIS } from "#src/features/conversations/message-reaction-picker";

test("quick reactions keep their seven-emoji order with checkmark last", () => {
  expect([...QUICK_REACTION_EMOJIS]).toEqual(["👍", "❤️", "🎉", "👀", "🔥", "😂", "✅"]);
  for (const emoji of QUICK_REACTION_EMOJIS) {
    expect(isValidReactionEmoji(emoji)).toBe(true);
  }
});

test("extended Unicode emojis pass reaction validation and schema", () => {
  for (const emoji of ["👌", "🫡", "🙌", "👨‍👩‍👧‍👦", "✅"]) {
    expect(isValidReactionEmoji(emoji)).toBe(true);
    expect(
      toggleMessageReactionInputSchema.safeParse({
        messageId: "00000000-0000-4000-8000-000000000001",
        emoji,
        active: true,
      }).success,
    ).toBe(true);
  }
});
