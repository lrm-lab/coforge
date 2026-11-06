import { describe, expect, test } from "bun:test";

import type { TrustedAgentActivity } from "#src/server/db/repositories/agent-activity.repositories.server";
import { usageLimitObservation } from "./usage-limit-events.server";

function activity(overrides: Partial<TrustedAgentActivity> = {}): TrustedAgentActivity {
  return {
    protocolMajor: 1,
    requestId: "req",
    workspaceId: "ws",
    agentId: "agent",
    computerId: "computer",
    launchId: "launch",
    clientSeq: 1,
    detailKind: "runtime_error",
    level: "error",
    detail: "",
    observedAtMs: 0,
    ...overrides,
  };
}

describe("usageLimitObservation", () => {
  test("a quota error with a provider and reset opens an exhausted observation", () => {
    const observation = usageLimitObservation(
      activity({
        runtimeProvider: "claude-code",
        runtimeError: {
          errorClass: "RateLimitError",
          errorReason: "quota_exhausted",
          fingerprint: "fp",
          retryNotBefore: "2026-11-07T00:00:00.000Z",
        },
      }),
    );
    expect(observation).toEqual({
      provider: "claude-code",
      resetsAt: new Date("2026-11-07T00:00:00.000Z"),
    });
  });

  test("a billing error without a reset opens an exhausted observation with no resetsAt", () => {
    const observation = usageLimitObservation(
      activity({
        runtimeProvider: "codex",
        runtimeError: {
          errorClass: "BillingError",
          errorReason: "billing_exhausted",
          fingerprint: "fp",
        },
      }),
    );
    expect(observation).toEqual({ provider: "codex", resetsAt: null });
  });

  test("an unusable retry time reads as no reset", () => {
    const observation = usageLimitObservation(
      activity({
        runtimeProvider: "codex",
        runtimeError: {
          errorClass: "RateLimitError",
          errorReason: "quota_exhausted",
          fingerprint: "fp",
          retryNotBefore: "not-a-date",
        },
      }),
    );
    expect(observation).toMatchObject({ provider: "codex", resetsAt: null });
  });

  test("a usage-limit error without a provider is ignored entirely", () => {
    for (const errorReason of ["quota_exhausted", "billing_exhausted"]) {
      expect(
        usageLimitObservation(
          activity({
            runtimeError: { errorClass: "E", errorReason, fingerprint: "fp" },
          }),
        ),
      ).toBeNull();
    }
  });

  test("every other frame is inert: other errors, ordinary work, stops", () => {
    // Recovery and gone detection live in the sweep, never on the write path —
    // and a daemon too old to send runtimeProvider changes no state at all.
    for (const frame of [
      activity({
        runtimeProvider: "codex",
        runtimeError: { errorClass: "AuthError", errorReason: "user_reauth", fingerprint: "fp" },
      }),
      activity({ detailKind: "tool_end", level: "info", runtimeProvider: "codex" }),
      activity({ detailKind: "idle", level: "info" }),
      activity({ detailKind: "stopped", level: "info", runtimeProvider: "codex" }),
      activity({ detailKind: "runtime_error", level: "error" }),
    ])
      expect(usageLimitObservation(frame)).toBeNull();
  });
});
