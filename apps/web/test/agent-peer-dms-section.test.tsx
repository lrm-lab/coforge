import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { AgentPeerDmList } from "#src/features/agents/profile-panel/agent-peer-dms-section";
import { m } from "#src/paraglide/messages";

type Card = Parameters<typeof AgentPeerDmList>[0]["cards"][number];

function card(overrides: Partial<Card> = {}): Card {
  return {
    peer: {
      agentId: "22222222-3333-4444-8555-666666666666",
      name: "reviewer",
      displayName: "Reviewer",
      avatar: "/avatars/reviewer.png",
    },
    preview: "Looks good to me.",
    lastMessageAt: new Date("2026-10-24T20:00:00Z"),
    lastFromPeer: true,
    limited: false,
    ...overrides,
  };
}

function render(cards: Card[]) {
  return renderToStaticMarkup(
    <AgentPeerDmList cards={cards} agentName="Builder" timeZone={null} />,
  );
}

/** The markup's text with its tags removed. */
function visibleText(markup: string) {
  return markup.replace(/<[^>]+>/g, "");
}

test("renders nothing at all without cards", () => {
  expect(render([])).toBe("");
});

test("names the peer with its handle and quotes the peer's last line under its name", () => {
  const text = visibleText(render([card()]));
  expect(text).toContain(m.agent_profile_section_peer_dms());
  expect(text).toContain("Reviewer");
  expect(text).toContain("@reviewer");
  expect(text).toContain(
    m.agent_peer_dm_last_line({ speaker: "Reviewer", preview: "Looks good to me." }),
  );
});

test("puts the panel's own Agent before the line it wrote last", () => {
  const text = visibleText(render([card({ lastFromPeer: false, preview: "Pushed the fix." })]));
  expect(text).toContain(
    m.agent_peer_dm_last_line({ speaker: "Builder", preview: "Pushed the fix." }),
  );
});

test("marks a limited conversation as paused and only that one", () => {
  const limited = visibleText(render([card({ limited: true })]));
  expect(limited).toContain(m.agent_peer_dm_paused());
  expect(visibleText(render([card()]))).not.toContain(m.agent_peer_dm_paused());
});

test("offers nothing to open, follow or answer", () => {
  const markup = render([card({ limited: true })]);
  expect(markup).not.toContain("<a ");
  expect(markup).not.toContain("<button");
});
