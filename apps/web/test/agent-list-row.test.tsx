import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { AgentListRow } from "#src/features/agents/agent-list-popover";
import { mascotStaticUrl } from "#src/features/agents/mascot-contract";

// Task #134: the busy and following-Agents popovers show each Agent's live state, so a row with
// the Agent's mascot draws the moving one; a row without it (a deleted Agent, an app bot, a
// mascot not known yet) keeps the still picture.
test("a popover row draws the moving mascot only when it has the Agent's mascot", () => {
  const moving = renderToStaticMarkup(
    <AgentListRow agentId="a1" name="Atlas" src="https://example.com/a.webp" mascot="blue" />,
  );
  expect(moving).toContain(mascotStaticUrl("blue"));
  expect(moving).not.toContain("https://example.com/a.webp");

  const still = renderToStaticMarkup(
    <AgentListRow agentId="a1" name="Atlas" src="https://example.com/a.webp" />,
  );
  expect(still).toContain("https://example.com/a.webp");
  expect(still).not.toContain(mascotStaticUrl("blue"));
});
