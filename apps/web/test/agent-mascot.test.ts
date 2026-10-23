import { expect, test } from "bun:test";

import {
  AGENT_MASCOTS,
  agentAvatarUrl,
  agentMascot,
  defaultAgentMascot,
  isAgentMascot,
} from "#src/features/agents/agent-mascot";
import { mascotStaticUrl } from "#src/features/agents/mascot-contract";

// Frank, 2026-10-24: every Agent shows one of seven platform mascots. Its creator picks one;
// until then its id does.
test("an Agent that has not been given a mascot shows the one its id chooses", () => {
  const picked = agentAvatarUrl("agent-1");
  expect(picked).toStartWith("/agent-avatars/mascot-");
  expect(agentAvatarUrl("agent-1", null)).toBe(picked);
  expect(agentAvatarUrl("agent-1", undefined)).toBe(picked);
  expect(mascotStaticUrl(defaultAgentMascot("agent-1"))).toBe(picked);
  const spread = new Set(
    Array.from({ length: 200 }, (_, index) => defaultAgentMascot(`agent-${index}`)),
  );
  expect(spread.size).toBe(AGENT_MASCOTS.length);
  expect(AGENT_MASCOTS).toEqual(["blue", "orange", "pink", "green", "purple", "black", "yellow"]);
});

test("the creator's mascot wins over the id's, and an unknown key falls back to the id's", () => {
  const fallback = defaultAgentMascot("agent-1");
  const other = AGENT_MASCOTS.find((mascot) => mascot !== fallback)!;
  expect(agentMascot("agent-1", other)).toBe(other);
  expect(agentAvatarUrl("agent-1", other)).toBe(`/agent-avatars/mascot-${other}-3.webp`);
  expect(agentMascot("agent-1", "teal")).toBe(fallback);
  expect(isAgentMascot("teal")).toBeFalse();
  expect(AGENT_MASCOTS.every(isAgentMascot)).toBeTrue();
});
