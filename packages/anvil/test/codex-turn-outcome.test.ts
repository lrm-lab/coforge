import { describe, expect, test } from "bun:test";
import { codexTurnOutcome } from "@lrm/coforge-anvil/codex";

describe("codexTurnOutcome", () => {
  test("a completed or interrupted turn carries no failure", () => {
    expect(codexTurnOutcome({ id: "t", status: "completed" })).toEqual({ status: "completed" });
    expect(codexTurnOutcome({ id: "t", status: "interrupted" })).toEqual({
      status: "interrupted",
    });
  });

  test("a failed turn carries the provider's message and code", () => {
    expect(
      codexTurnOutcome({
        id: "t",
        status: "failed",
        error: { message: "usage limit reached", code: "usageLimitExceeded" },
      }),
    ).toEqual({
      status: "failed",
      failure: { message: "usage limit reached", code: "usageLimitExceeded" },
    });
  });

  test("any other status fails, with a fallback message and no code when the error says nothing", () => {
    expect(codexTurnOutcome({ id: "t", status: "inProgress" })).toEqual({
      status: "failed",
      failure: { message: "Codex turn failed." },
    });
    expect(codexTurnOutcome({ id: "t", status: "failed", error: { code: 7 } })).toEqual({
      status: "failed",
      failure: { message: "Codex turn failed." },
    });
  });

  test("a replay the provider cannot decrypt asks for a cold-started session", () => {
    const recovery = { sessionRecovery: "provider_replay_rejected" } as const;
    const failed = (error: Record<string, unknown>) =>
      codexTurnOutcome({ id: "t", status: "failed", error });
    expect(failed({ message: "Bad request", code: "invalid_encrypted_content" })).toEqual({
      status: "failed",
      failure: { message: "Bad request", code: "invalid_encrypted_content", ...recovery },
    });
    // A real Codex may surface only the message text, in any case.
    expect(failed({ message: "400 invalid_encrypted_content: could not verify" })).toEqual({
      status: "failed",
      failure: { message: "400 invalid_encrypted_content: could not verify", ...recovery },
    });
    expect(failed({ message: "Encrypted content COULD NOT BE DECRYPTED OR PARSED." })).toEqual({
      status: "failed",
      failure: { message: "Encrypted content COULD NOT BE DECRYPTED OR PARSED.", ...recovery },
    });
  });

  test("Codex's TurnError holds the API's text in message or additionalDetails, never in a code", () => {
    // `codex app-server generate-json-schema` (0.167.0): TurnError is { message, codexErrorInfo,
    // additionalDetails, misalignment }; codexErrorInfo is a classification like "badRequest".
    const failure = codexTurnOutcome({
      id: "t",
      status: "failed",
      error: {
        message: "Turn failed",
        codexErrorInfo: "badRequest",
        additionalDetails: "invalid_encrypted_content: Encrypted content could not be verified",
      },
    }).failure;
    expect(failure).toEqual({
      message: "Turn failed",
      sessionRecovery: "provider_replay_rejected",
    });
    expect(
      codexTurnOutcome({
        id: "t",
        status: "failed",
        error: { message: "Turn failed", codexErrorInfo: "badRequest", additionalDetails: null },
      }).failure,
    ).toEqual({ message: "Turn failed" });
  });

  test("other failures, near misses included, ask for no recovery", () => {
    for (const error of [
      { message: "usage limit reached", code: "usageLimitExceeded" },
      { message: "Encrypted content is required", code: "invalid_request" },
      { message: "The body could not be parsed", code: "invalid_encrypted_content_v2" },
      { message: "Invalid encrypted payload" },
      // Another component's decrypt failure is not the thread's history.
      { message: "Authorization header could not be decrypted or parsed" },
      {
        message: "Turn failed",
        additionalDetails: "The gateway token could not be decrypted or parsed",
      },
    ])
      expect(codexTurnOutcome({ id: "t", status: "failed", error }).failure).not.toHaveProperty(
        "sessionRecovery",
      );
  });
});
