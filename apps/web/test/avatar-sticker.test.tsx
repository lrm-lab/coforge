import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { AgentMascotAvatar } from "#src/features/agents/agent-mascot-avatar";
import { IdentityAvatar } from "#src/features/avatars/identity-avatar";
import { mascotStaticUrl } from "#src/features/agents/mascot-contract";

// Frank's references (2026-10-23): every Agent mascot is a sticker, the white-edged figure drawn
// larger than its box, unclipped, with no backdrop behind it. The moving avatar (DM row, Agent
// card, profile) once fell back to the clipped photo tile because it has no `src`.
test("a moving mascot avatar is the same sticker as a still one, never a clipped tile", () => {
  const moving = renderToStaticMarkup(<AgentMascotAvatar mascot="blue" name="Atlas" size="sm" />);
  const still = renderToStaticMarkup(
    <IdentityAvatar src={mascotStaticUrl("blue")} alt="" size="sm" />,
  );
  for (const markup of [moving, still]) {
    expect(markup).toContain("avatar-sticker ");
    expect(markup).toContain("avatar-sticker-figure");
    expect(markup).not.toContain("overflow-hidden");
  }
});

test("a person's photo keeps the base avatar's clipped tile", () => {
  const person = renderToStaticMarkup(
    <IdentityAvatar src="https://example.com/p.webp" alt="" size="sm" />,
  );
  expect(person).not.toContain("avatar-sticker");
  expect(person).toContain("overflow-hidden");
});
