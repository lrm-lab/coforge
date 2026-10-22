import { expect, test } from "bun:test";
import { AGENT_NAME_MAX_LENGTH, AGENT_NAME_PATTERN } from "@lrm/coforge-sdk/internal";

import {
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

test("a random username is valid and differs from the one it replaces", () => {
  const first = randomAgentUsername(undefined, () => 0);
  expect(first).toMatch(AGENT_NAME_PATTERN);
  expect(randomAgentUsername(first, () => 0)).not.toBe(first);
});
