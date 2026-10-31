import { expect, test } from "bun:test";
import { canonicalClaudePlan } from "@lrm/coforge-anvil/claude-code";

test("a rate-limit tier names the plan, so the two Max plans read apart", () => {
  // Anthropic's $200 plan, renamed Ultra; both Max plans answer subscription_type "max".
  expect(canonicalClaudePlan("default_claude_max_20x", "max")).toBe("Ultra");
  expect(canonicalClaudePlan("default_claude_max_5x", "max")).toBe("Max");
  expect(canonicalClaudePlan("default_claude_pro", "pro")).toBe("Pro");
  expect(canonicalClaudePlan("default_claude_team", "team")).toBe("Team");
  expect(canonicalClaudePlan("default_claude_enterprise", "enterprise")).toBe("Enterprise");
});

test("without a known tier the protocol's own word is capitalised, never shown raw", () => {
  expect(canonicalClaudePlan(undefined, "max")).toBe("Max");
  expect(canonicalClaudePlan(undefined, "claude max")).toBe("Claude Max");
  expect(canonicalClaudePlan("something_new", "max")).toBe("Max");
  expect(canonicalClaudePlan(undefined, undefined)).toBeUndefined();
});
