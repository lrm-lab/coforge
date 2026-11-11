import { expect, test } from "bun:test";
import {
  AGENT_CREDENTIAL_RESTORED_METHOD,
  decodeAgentCredentialRestored,
  encodeAgentCredentialRestored,
} from "./index";

const restored = {
  protocolMajor: 1,
  requestId: "request-a",
  workspaceId: "workspace-a",
  agentId: "agent-a",
  reason: "user_reauth",
  releaseCause: "credentials_changed",
  launchId: "launch-a",
  restoredAtMs: 1_700_000_000_000,
} as const;

test("the method is versioned under the agent namespace", () => {
  expect(AGENT_CREDENTIAL_RESTORED_METHOD).toBe("agent:v1:credential:restored");
});

test("a report round-trips, with or without the launch it was shown on", () => {
  expect(decodeAgentCredentialRestored(encodeAgentCredentialRestored(restored))).toEqual(restored);
  const { launchId: _, ...closed } = restored;
  expect(decodeAgentCredentialRestored(encodeAgentCredentialRestored(closed))).toEqual(closed);
});

test.each([
  ["a protocol major other than 1", { protocolMajor: 2 }],
  ["no agent", { agentId: " " }],
  ["a reason it does not know", { reason: "other" }],
  ["no time it was restored at", { restoredAtMs: 0 }],
])("%s is refused", (_name, change) => {
  expect(() => encodeAgentCredentialRestored({ ...restored, ...change } as never)).toThrow(
    "invalid credential restored",
  );
});

test("a release cause this build does not know is kept as unknown, not refused", () => {
  // A daemon that adds a cause must not need this server released first: the cause is diagnostic,
  // so the report (and the Activity that ends the failure) stands either way.
  const newer = { ...restored, releaseCause: "explicit_start_of_next_build" as never };
  expect(decodeAgentCredentialRestored(encodeAgentCredentialRestored(newer))).toEqual({
    ...restored,
    releaseCause: "unknown",
  });
});
