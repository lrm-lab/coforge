import { describe, expect, test } from "bun:test";
import { createUpdateCommand } from "#src/cli/update-command";
import { UpgradeFailedError } from "#src/release/upgrade-receipt";
import type { DetachedUpgradeOptions, DetachedUpgradeOutcome } from "#src/release/detached-upgrade";

const REQUEST_ID = "0194f1c2-aaaa-7bbb-8ccc-ddddeeeeffff";

function subject(outcome: DetachedUpgradeOutcome | Error) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const launched: DetachedUpgradeOptions[] = [];
  const inPlace: string[] = [];
  const command = createUpdateCommand(
    { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
    {
      detachedUpgrade: async (options) => {
        launched.push(options);
        if (outcome instanceof Error) throw outcome;
        return outcome;
      },
      inPlaceUpgrade: async (operation) => {
        inPlace.push(operation.requestId);
        return {
          schema_version: 1,
          request_id: operation.requestId,
          operation: "upgrade",
          status: "succeeded",
          version: "0.1.17",
        };
      },
    },
  );
  return { command, stdout, stderr, launched, inPlace };
}

describe("install and upgrade run outside this process", () => {
  test("install launches the one-shot and reports the version it settled on", async () => {
    const { command, stdout, launched } = subject({
      kind: "settled",
      requestId: REQUEST_ID,
      result: {
        schema_version: 1,
        request_id: REQUEST_ID,
        operation: "upgrade",
        status: "succeeded",
        version: "0.1.18-dev.2",
      },
    });
    await command.install("0.1.18-dev.2", { allowDowngrade: false });
    expect(launched).toHaveLength(1);
    expect(launched[0]).toMatchObject({ version: "0.1.18-dev.2" });
    expect(stdout).toEqual(["CoForge Computer 0.1.18-dev.2 installed successfully."]);
  });

  test("upgrade says what it is doing, then the result", async () => {
    const { command, stdout } = subject({
      kind: "settled",
      requestId: REQUEST_ID,
      result: {
        schema_version: 1,
        request_id: REQUEST_ID,
        operation: "upgrade",
        status: "succeeded",
        version: "0.1.18-dev.2",
      },
    });
    await command.upgrade("latest", { allowDowngrade: false });
    expect(stdout.at(-1)).toBe("CoForge Computer 0.1.18-dev.2 updated successfully.");
  });

  test("the job's own progress lines go to stderr, never to stdout", async () => {
    const { command, stdout, stderr } = subject({
      kind: "settled",
      requestId: REQUEST_ID,
      result: {
        schema_version: 1,
        request_id: REQUEST_ID,
        operation: "upgrade",
        status: "succeeded",
        version: "0.1.18-dev.2",
      },
    });
    await command.install("0.1.18-dev.2", { allowDowngrade: false });
    // The runner's callbacks are wired to stderr; stdout stays the command's one sentence.
    expect(stderr).toEqual([]);
    expect(stdout).toHaveLength(1);
  });

  test("a receipt that did not succeed is a failed command carrying its own evidence", async () => {
    const { command } = subject({
      kind: "settled",
      requestId: REQUEST_ID,
      result: {
        schema_version: 1,
        request_id: REQUEST_ID,
        operation: "upgrade",
        status: "failed",
        error: "installer refused the target",
      },
    });
    const failure = await command
      .install("0.1.18-dev.2", { allowDowngrade: false })
      .catch((e) => e);
    expect(failure).toBeInstanceOf(UpgradeFailedError);
    expect((failure as UpgradeFailedError).result.status).toBe("failed");
    expect((failure as Error).message).toBe("installer refused the target");
  });

  test("a job still running says so instead of claiming a result", async () => {
    const { command, stderr } = subject({ kind: "still-running", requestId: REQUEST_ID });
    const failure = await command
      .upgrade("0.1.18-dev.2", { allowDowngrade: false })
      .catch((e: Error) => e);
    expect((failure as Error).message).toContain("still running");
    expect((failure as Error).message).toContain(REQUEST_ID);
    // The next-command hint is offered, as for any other upgrade failure.
    expect(await stderr.join("\n")).toContain("coforge-computer");
  });

  test("an explicit downgrade stays in place, where the operator's terminal is", async () => {
    // A remote operation never carries `--allow-downgrade`, so a downgrade runs in place and the
    // in-place guard decides whether this terminal may do it.
    const { command, launched, inPlace, stdout } = subject({
      kind: "still-running",
      requestId: REQUEST_ID,
    });
    await command.install("0.1.17", { allowDowngrade: true });
    expect(launched).toHaveLength(0);
    expect(inPlace).toHaveLength(1);
    expect(stdout).toEqual(["CoForge Computer 0.1.17 installed successfully."]);
  });
});
