import { expect, test } from "bun:test";

import {
  actionCardTitle,
  type ToolActionCardView,
} from "#src/features/conversations/action-card-labels";

test("every tool card kind has a title of its own, none falls back to another's", () => {
  const kinds: ToolActionCardView["kind"][] = [
    "channel:create",
    "channel:add_member",
    "agent:create",
    "app:grant_agent",
    "app:register",
    "app:recover_owner",
    "page:fill",
    "desktop:takeover",
  ];
  const titles = kinds.map((kind) => actionCardTitle({ kind } as ToolActionCardView));
  expect(new Set(titles).size).toBe(kinds.length);
  expect(() => actionCardTitle({ kind: "questions" } as unknown as ToolActionCardView)).toThrow();
});
