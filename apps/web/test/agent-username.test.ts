import { expect, test } from "bun:test";
import { AGENT_NAME_MAX_LENGTH, AGENT_NAME_PATTERN } from "@lrm/coforge-sdk/internal";

import {
  availableAgentUsername,
  finishedAgentUsername,
  randomAgentUsername,
  typedAgentUsername,
} from "#src/features/agents/agent-username";

test("typing turns any text into the username form as it goes", () => {
  expect(typedAgentUsername("Release Fix!")).toBe("release-fix");
  expect(typedAgentUsername("code_review  bot")).toBe("code-review-bot");
  expect(typedAgentUsername("a - b")).toBe("a-b");
  expect(typedAgentUsername("José")).toBe("jose");
  expect(typedAgentUsername("-lead")).toBe("lead");
  expect(typedAgentUsername("前端")).toBe("");
});

test("a trailing hyphen stays while typing so the next word can follow", () => {
  expect(typedAgentUsername("release ")).toBe("release-");
  expect(finishedAgentUsername("release-")).toBe("release");
});

test("a username never grows past the server's limit", () => {
  expect(typedAgentUsername("a".repeat(AGENT_NAME_MAX_LENGTH + 10))).toHaveLength(
    AGENT_NAME_MAX_LENGTH,
  );
});

test("a random username is a valid hyphenated handle and differs from the one it replaces", () => {
  const first = randomAgentUsername(undefined, () => 0.12345);
  expect(first).toMatch(AGENT_NAME_PATTERN);
  expect(first).toContain("-");
  expect(first.length).toBeLessThanOrEqual(AGENT_NAME_MAX_LENGTH);
  expect(randomAgentUsername(first, () => 0.12345)).not.toBe(first);
});

test("randomAgentUsername avoids taken and previously seen names across rolls", () => {
  const seen = new Set<string>();
  const taken = new Set<string>();
  let current: string | undefined;
  for (let index = 0; index < 30; index++) {
    const next = randomAgentUsername(current, () => index / 30, taken, seen);
    expect(next).toMatch(AGENT_NAME_PATTERN);
    expect(seen.has(next)).toBe(false);
    expect(taken.has(next)).toBe(false);
    seen.add(next);
    taken.add(next);
    current = next;
  }
  expect(seen.size).toBe(30);
});

test("availableAgentUsername moves deterministically when taken", () => {
  const taken = new Set(["swift-otter"]);
  const first = availableAgentUsername("swift-otter", taken);
  const second = availableAgentUsername("swift-otter", taken);
  expect(first).toBe(second);
  expect(first).not.toBe("swift-otter");
  expect(first).toMatch(AGENT_NAME_PATTERN);
  expect(availableAgentUsername("swift-otter", new Set())).toBe("swift-otter");
});
