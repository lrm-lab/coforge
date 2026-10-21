import { expect, test } from "bun:test";
import { AgentServiceTierSchema } from "#src/internal/gen/coforge/rpc/v1/workspace_pb";
import { encodeAgentServiceTier, decodeAgentServiceTier } from "./index";

function serviceTier() {
  return {
    protocolMajor: 1,
    requestId: "report",
    workspaceId: "w",
    computerId: "c",
    agentId: "a",
    provider: "claude-code" as const,
    launchId: "launch",
    sessionId: "native-session",
    requested: true,
    observed: "on" as const,
    observedAtMs: 1_758_000_000_000,
    daemonInstanceId: "daemon",
    clientSeq: 3,
  };
}

test("service tier round-trips and rejects a missing scope field", () => {
  const message = serviceTier();
  expect(decodeAgentServiceTier(encodeAgentServiceTier(message))).toEqual(message);
  expect(() => encodeAgentServiceTier({ ...message, launchId: "" })).toThrow();
  expect(() => encodeAgentServiceTier({ ...message, workspaceId: "" })).toThrow();
  expect(() => encodeAgentServiceTier({ ...message, sessionId: "" })).toThrow();
});

test("round-trips every observed value and a non-requesting launch", () => {
  for (const observed of ["on", "off", "cooldown", "unreported"] as const) {
    const message = { ...serviceTier(), requested: false, observed };
    expect(decodeAgentServiceTier(encodeAgentServiceTier(message))).toEqual(message);
  }
});

test("rejects an invalid protocol, provider, observed value, and numeric field", () => {
  const message = serviceTier();
  expect(() => encodeAgentServiceTier({ ...message, protocolMajor: 2 })).toThrow(
    "invalid service tier protocol/provider",
  );
  expect(() =>
    encodeAgentServiceTier({ ...message, provider: "unknown" as "claude-code" }),
  ).toThrow("invalid service tier protocol/provider");
  expect(() => encodeAgentServiceTier({ ...message, observed: "priority" as "on" })).toThrow(
    "invalid service tier observed",
  );
  expect(() => encodeAgentServiceTier({ ...message, observedAtMs: 0 })).toThrow(
    "invalid service tier observedAtMs",
  );
  expect(() => encodeAgentServiceTier({ ...message, clientSeq: 0 })).toThrow(
    "invalid service tier clientSeq",
  );
});

test("keeps wire tags stable, numbered contiguously", () => {
  const fields = Object.fromEntries(
    AgentServiceTierSchema.fields.map((field) => [field.localName, field.number]),
  );
  expect(fields).toMatchObject({
    protocolMajor: 1,
    requestId: 2,
    workspaceId: 3,
    computerId: 4,
    agentId: 5,
    provider: 6,
    launchId: 7,
    sessionId: 8,
    requested: 9,
    observed: 10,
    observedAtMs: 11,
    daemonInstanceId: 12,
    clientSeq: 13,
  });
});
