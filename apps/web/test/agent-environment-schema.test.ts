import { expect, test } from "bun:test";
import { saveAgentEnvironmentInputSchema } from "#src/features/agents/agent.schemas";

const agentId = "01965b5e-7a00-7000-8000-000000000001";

test("saveAgentEnvironmentInputSchema accepts up to 64 entries with bounded keys and values", () => {
  const maxEntries = Object.fromEntries(
    Array.from({ length: 64 }, (_, index) => [
      `VAR_${String(index).padStart(2, "0")}_${"A".repeat(121)}`,
      "v".repeat(8192),
    ]),
  );
  expect(
    saveAgentEnvironmentInputSchema.safeParse({
      agentId,
      envVars: maxEntries,
    }).success,
  ).toBe(true);
});

test("saveAgentEnvironmentInputSchema rejects more than 64 entries", () => {
  const tooMany = Object.fromEntries(
    Array.from({ length: 65 }, (_, index) => [`VAR_${index}`, "ok"]),
  );
  expect(
    saveAgentEnvironmentInputSchema.safeParse({
      agentId,
      envVars: tooMany,
    }).success,
  ).toBe(false);
});

test("saveAgentEnvironmentInputSchema rejects keys over 128 chars and values over 8192 chars", () => {
  expect(
    saveAgentEnvironmentInputSchema.safeParse({
      agentId,
      envVars: { ["K".repeat(129)]: "ok" },
    }).success,
  ).toBe(false);

  expect(
    saveAgentEnvironmentInputSchema.safeParse({
      agentId,
      envVars: { VALID_KEY: "v".repeat(8193) },
    }).success,
  ).toBe(false);
});
