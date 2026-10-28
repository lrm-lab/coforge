import {
  RuntimeStartFailedError,
  VERSION_PROBE_TIMEOUT_MS,
  withDeadline,
} from "@lrm/coforge-anvil";
import { dshVersionFromOutput } from "@lrm/coforge-anvil/dsh";
import { scrubStderrHint } from "@lrm/coforge-anvil";

/**
 * Reads DSH's `--version` the way its launch does, and reports a CLI that cannot start as exactly
 * that. The preview pin fails closed either way, but a shim or launcher that dies says why
 * ("No version is set for shim: node") instead of reading as a version judgement. `stderr` is
 * captured for that first line only, through Anvil's shared redaction.
 */
export async function readDshVersionOutput(
  command: readonly string[],
  versionFrom: (output: string) => string | undefined = dshVersionFromOutput,
): Promise<string | undefined> {
  let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    child = Bun.spawn({ cmd: [...command, "--version"], stdout: "pipe", stderr: "pipe" });
  } catch (error) {
    // A launcher that cannot even be spawned (a missing shim, an unreadable binary) is the same
    // start failure, before there is any stderr to quote.
    throw new RuntimeStartFailedError(
      "DeepSeek Harness could not be started; check that its executable runs on this Computer",
      undefined,
      { cause: error },
    );
  }
  try {
    const [output, stderr, exitCode] = await withDeadline(
      Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]),
      VERSION_PROBE_TIMEOUT_MS,
      () =>
        new RuntimeStartFailedError(
          "DeepSeek Harness did not answer its version check in time; check that its executable runs on this Computer",
        ),
    );
    if (exitCode !== 0)
      throw new RuntimeStartFailedError(
        `DeepSeek Harness exited ${exitCode} when asked for its version; check that its executable runs on this Computer`,
        stderrHint(stderr),
      );
    return versionFrom(output);
  } catch (error) {
    if (error instanceof RuntimeStartFailedError) throw error;
    throw new RuntimeStartFailedError(
      "DeepSeek Harness could not be started; check that its executable runs on this Computer",
      stderrHint(""),
      { cause: error },
    );
  } finally {
    child.kill();
  }
}

/** The first non-blank stderr line, redacted and bounded — the one line a person needs. */
function stderrHint(stderr: string): string | undefined {
  const line = stderr.split("\n").find((candidate) => candidate.trim().length > 0);
  return line === undefined ? undefined : scrubStderrHint(line);
}
