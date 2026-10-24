import { describe, expect, test } from "bun:test";
import { writeCliFailure } from "#src/cli/failure-output";
import { CliError, LOGIN_HINTS, SETUP_HINTS } from "#src/errors";
import { UpgradeFailedError } from "#src/release/upgrade-receipt";
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
  test("a CliError prints what happened, the next command, and the state guarantee", () => {
    expect(capture(new CliError("X_FAILED", "It failed.", "Try again."))).toEqual({
      stdout: [],
      stderr: [
        "What happened (X_FAILED): It failed.\nNext: coforge-computer doctor\nState: No local Computer state change was confirmed by this command.",
      ],
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
      "What happened (AUTH_FAILED): Login failed: fetch failed: token=[redacted]\nNext: coforge-computer login\nState: No local Computer state change was confirmed by this command.",
    ]);
  });

  test("human failures redact URL query credentials and expose the next command", () => {
    expect(
      capture(
        new CliError(
          "AUTH_NETWORK_ERROR",
          "Could not reach https://user:password@example.test/login?access_token=secret.",
          LOGIN_HINTS.AUTH_NETWORK_ERROR,
        ),
      ).stderr,
    ).toEqual([
      "What happened (AUTH_NETWORK_ERROR): Could not reach https://%5BREDACTED_USER%5D:%5BREDACTED_PASSWORD%5D@example.test/login?[REDACTED_QUERY]\nNext: coforge-computer login\nState: No local Computer state change was confirmed by this command.",
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

  test("other commands use the same human failure contract", () => {
    expect(capture(new UpdateError("UPDATE_FEED_INVALID", "Bad feed.")).stderr).toEqual([
      "What happened (UPDATE_FEED_INVALID): Bad feed.\nNext: coforge-computer upgrade\nState: No completed upgrade was confirmed by this command.",
    ]);
    // --json only shapes the login, setup and CliError results.
    expect(capture(new Error("disk full"), { json: true })).toEqual({
      stdout: [],
      stderr: [
        "What happened (COMPUTER_FAILED): disk full\nNext: coforge-computer doctor\nState: No local Computer state change was confirmed by this command.",
      ],
    });
    expect(capture("not an error").stderr).toEqual([
      "What happened (COMPUTER_FAILED): coforge-computer failed\nNext: coforge-computer doctor\nState: No local Computer state change was confirmed by this command.",
    ]);
  });

  test("a failed upgrade prints its receipt's error code with its message, when it has one", () => {
    const result = {
      schema_version: 1,
      request_id: "0b7d2c9e-3a1f-4c8e-9d2b-5f6a7b8c9d0e",
      operation: "upgrade",
      status: "failed",
      error: "manifest.json: Connection reset by peer (os error 104)",
    } as const;
    expect(
      capture(
        new UpgradeFailedError(result.error, { ...result, errorCode: "UPDATE_DOWNLOAD_FAILED" }),
      ).stderr,
    ).toEqual([
      "What happened (UPDATE_DOWNLOAD_FAILED): manifest.json: Connection reset by peer (os error 104)\nNext: coforge-computer upgrade\nState: No completed upgrade was confirmed by this command.",
    ]);
    expect(capture(new UpgradeFailedError(result.error, result)).stderr).toEqual([
      "What happened (UPGRADE_FAILED): manifest.json: Connection reset by peer (os error 104)\nNext: coforge-computer upgrade\nState: No completed upgrade was confirmed by this command.",
    ]);
  });
});
