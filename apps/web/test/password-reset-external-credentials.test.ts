import type { CodeDestination } from "#src/features/auth/code-destination";
import { describe, expect, spyOn, test } from "bun:test";
import { resetPasswordWithCode } from "#src/server/auth/password-reset.server";
import type { AuthingAuthentication } from "#src/server/auth/authing-authentication.server";
import { NO_RESET_CODE_RATE_LIMITS } from "#src/server/auth/sign-in-rate-limits.server";

const DESTINATION = { kind: "email", email: "a@example.com" } as const;

function authing(outcome: "ok" | "refused"): AuthingAuthentication {
  return {
    verifyResetCode: async () => "token",
    resetPassword: async () => {
      if (outcome === "refused") throw new Error("down");
    },
  } as unknown as AuthingAuthentication;
}

function reset(outcome: "ok" | "refused", onPasswordReset: (d: CodeDestination) => Promise<void>) {
  return resetPasswordWithCode({
    config: {} as never,
    destination: DESTINATION,
    passCode: "123456",
    newPassword: "pw",
    rateLimits: NO_RESET_CODE_RATE_LIMITS,
    authing: authing(outcome),
    onPasswordReset,
  });
}

describe("resetPasswordWithCode and external credentials", () => {
  test("an updated reset runs the revocation for its destination", async () => {
    const seen: unknown[] = [];
    expect(await reset("ok", async (d) => void seen.push(d))).toEqual({ status: "updated" });
    expect(seen).toEqual([DESTINATION]);
  });

  test("a failed reset revokes nothing", async () => {
    let ran = false;
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await reset("refused", async () => void (ran = true))).status).toBe("failed");
      expect(ran).toBe(false);
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });

  test("a revocation failure still answers updated and logs a structured event", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await reset("ok", async () => {
        throw new Error("db down");
      });
      expect(result).toEqual({ status: "updated" });
      const line = JSON.parse(String(warn.mock.calls[0]?.[0]));
      expect(line.event).toBe("external_agent.password_reset_revoke_failed");
      expect(JSON.stringify(line)).not.toContain("a@example.com");
    } finally {
      warn.mockRestore();
    }
  });
});
