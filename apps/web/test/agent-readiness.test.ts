import { expect, test } from "bun:test";
import {
  agentReadiness,
  READINESS_STATES,
  readinessSelfHeals,
  type AgentReadinessInput,
} from "#src/server/agents/agent-readiness.server";

const NOW = 1_000_000;

function input(overrides: Partial<AgentReadinessInput> = {}): AgentReadinessInput {
  return {
    nowMs: NOW,
    computerOnline: true,
    upgradeExpiresAtMs: null,
    runtimeRefusal: null,
    stopReason: null,
    ...overrides,
  };
}

test("an online Computer with nothing in the way is ready", () => {
  expect(agentReadiness(input())).toEqual({ state: "ready" });
});

test("an offline Computer blocks until it reconnects, and its owner is the one to act", () => {
  const readiness = agentReadiness(input({ computerOnline: false }));
  expect(readiness).toMatchObject({
    state: "computer_offline",
    resource: "computer",
    behaviour: "blocked",
    actor: "computer_owner",
    exits: ["computer_reconnects"],
    also: [],
  });
  expect(readinessSelfHeals(readiness)).toBe(false);
});

test("an upgrade in its window waits and heals by itself, even while the Computer is offline", () => {
  const readiness = agentReadiness(
    input({ computerOnline: false, upgradeExpiresAtMs: NOW + 1_000 }),
  );
  expect(readiness).toMatchObject({
    state: "computer_updating",
    behaviour: "waiting",
    actor: "none",
    exits: ["computer_reconnects", "upgrade_deadline_elapsed"],
    also: ["computer_offline"],
  });
  expect(readinessSelfHeals(readiness)).toBe(true);
});

test("an upgrade past its deadline stops counting, and the offline Computer shows as blocked", () => {
  expect(agentReadiness(input({ computerOnline: false, upgradeExpiresAtMs: NOW }))).toMatchObject({
    state: "computer_offline",
    also: [],
  });
  expect(agentReadiness(input({ upgradeExpiresAtMs: NOW }))).toEqual({ state: "ready" });
});

test("a runtime the Computer does not have, cannot use, or has not reported is runtime_missing", () => {
  for (const runtimeRefusal of [
    "runtime_missing",
    "runtime_unusable",
    "runtime_unconfirmed",
  ] as const)
    expect(agentReadiness(input({ runtimeRefusal }))).toMatchObject({
      state: "runtime_missing",
      behaviour: "blocked",
      actor: "computer_owner",
    });
});

test("a refusal that is not about the runtime being there is not a readiness state", () => {
  for (const runtimeRefusal of [
    "runtime_not_shared",
    "model_missing",
    "fast_mode_unsupported",
  ] as const)
    expect(agentReadiness(input({ runtimeRefusal }))).toEqual({ state: "ready" });
});

test("the Computer not being connected is the Computer's state, not the runtime's", () => {
  expect(agentReadiness(input({ runtimeRefusal: "not_connected" }))).toMatchObject({
    state: "computer_offline",
    also: [],
  });
});

test("a login-required stop reason needs the Agent's person to sign in and start", () => {
  const readiness = agentReadiness(input({ stopReason: "runtime_login_required" }));
  expect(readiness).toMatchObject({
    state: "runtime_login_required",
    resource: "login",
    behaviour: "blocked",
    actor: "agent_owner",
    exits: ["person_signs_in_and_starts"],
  });
  expect(readinessSelfHeals(readiness)).toBe(false);
});

test("other stop reasons are not login", () => {
  expect(agentReadiness(input({ stopReason: "rate_limited" }))).toEqual({ state: "ready" });
  expect(agentReadiness(input({ stopReason: null }))).toEqual({ state: "ready" });
});

test("the outer cause leads and the rest follow in order", () => {
  expect(
    agentReadiness(
      input({
        computerOnline: false,
        upgradeExpiresAtMs: NOW + 1,
        runtimeRefusal: "runtime_missing",
        stopReason: "runtime_login_required",
      }),
    ),
  ).toMatchObject({
    state: "computer_updating",
    also: ["computer_offline", "runtime_missing", "runtime_login_required"],
  });
  expect(
    agentReadiness(
      input({ runtimeRefusal: "runtime_unusable", stopReason: "runtime_login_required" }),
    ),
  ).toMatchObject({ state: "runtime_missing", also: ["runtime_login_required"] });
});

test("every state names its exits and only a waiting state heals by itself", () => {
  for (const [state, row] of Object.entries(READINESS_STATES)) {
    expect(row.exits.length).toBeGreaterThan(0);
    expect(row.behaviour === "waiting").toBe(state === "computer_updating");
  }
});
