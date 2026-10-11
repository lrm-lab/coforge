import { describe, expect, test } from "bun:test";
import { writeCliFailure } from "#src/cli/failure-output";
import { CliError, LOGIN_HINTS, SETUP_HINTS } from "#src/errors";
import { UpdateError } from "#src/updater";

function capture(
  error: unknown,
  selected: Partial<{ json: boolean; login: boolean; setup: boolean }> = {},
) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  writeCliFailure(
    { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
    error,
    { json: false, login: false, setup: false, ...selected },
  );
  return { stdout, stderr };
}

describe("writeCliFailure", () => {
  test("a CliError prints its code, message and hint", () => {
    expect(capture(new CliError("X_FAILED", "It failed.", "Try again."))).toEqual({
      stdout: [],
      stderr: ["X_FAILED: It failed.\nHint: Try again."],
    });
  });

  test("with --json a CliError is one JSON result on stdout", () => {
    const { stdout, stderr } = capture(new CliError("X_FAILED", "It failed.", "Try again."), {
      json: true,
    });
    expect(stderr).toEqual([]);
    expect(stdout.map((line) => JSON.parse(line))).toEqual([
      { ok: false, error: { code: "X_FAILED", message: "It failed.", hint: "Try again." } },
    ]);
  });

  test("any login failure keeps its cause, without token-shaped detail", () => {
    expect(capture(new Error("fetch failed: token=abc"), { login: true }).stderr).toEqual([
      `AUTH_FAILED: Login failed: fetch failed: token=[redacted]\nHint: ${LOGIN_HINTS.AUTH_FAILED}`,
    ]);
  });

  test("any setup failure is reported as a setup failure", () => {
    expect(capture(new Error("boom"), { setup: true, json: true }).stdout).toEqual([
      JSON.stringify({
        ok: false,
        error: {
          code: "SETUP_FAILED",
          message: "Workspace setup failed.",
          hint: SETUP_HINTS.SETUP_FAILED,
        },
      }),
    ]);
  });

  test("other commands print an UpdateError's code, and anything else only its message", () => {
    expect(capture(new UpdateError("UPDATE_FEED_INVALID", "Bad feed.")).stderr).toEqual([
      "UPDATE_FEED_INVALID: Bad feed.",
    ]);
    // --json only shapes the login, setup and CliError results.
    expect(capture(new Error("disk full"), { json: true })).toEqual({
      stdout: [],
      stderr: ["disk full"],
    });
    expect(capture("not an error").stderr).toEqual(["coforge-computer failed"]);
  });
});
