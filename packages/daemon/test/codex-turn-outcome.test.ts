import { describe, expect, test } from "bun:test";
import { codexTurnOutcome } from "#src/code-agent/codex/turn-outcome";

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
});
