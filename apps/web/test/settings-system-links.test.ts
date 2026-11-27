import { expect, test } from "bun:test";
import { settingsSystemLinks } from "#src/features/settings/settings-sections";
import { m } from "#src/paraglide/messages";

test("operator-only feedback inbox link appears in Settings System only for operators", () => {
  expect(settingsSystemLinks({})).toEqual([]);
  expect(settingsSystemLinks({ canViewFeedbackInbox: false })).toEqual([]);
  const links = settingsSystemLinks({ canViewFeedbackInbox: true });
  expect(links).toHaveLength(1);
  expect(links[0]!.id).toBe("feedback-inbox");
  expect(links[0]!.to).toBe("/w/$workspaceSlug/feedback");
  expect(links[0]!.label()).toBe(m.feedback_inbox_link());
});
