import {
  RuntimeStartFailedError,
  scrubStderrHint,
  VERSION_PROBE_TIMEOUT_MS,
  withDeadline,
} from "@lrm/coforge-anvil";

/**
 * Reads `[...command, "--version"]`, killing the child if it outlives the probe budget.
 *
 * A CLI that cannot start at all — the spawn throws, it exits non-zero, or it never answers —
 * throws `RuntimeStartFailedError` carrying its redacted first stderr line, so a shim or launcher
 * that dies says why ("No version is set for shim: node") instead of reading as a version
 * judgement. Only a CLI that ran and printed nothing that reads as a version is `undefined`.
 */
export async function readVersionOutput(
  command: readonly string[],
  versionFrom: (output: string) => string | undefined,
): Promise<string | undefined> {
  let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    child = Bun.spawn({ cmd: [...command, "--version"], stdout: "pipe", stderr: "pipe" });
  } catch (error) {
    // A launcher that cannot even be spawned (a missing shim, an unreadable binary) is the same
    // start failure, before there is any stderr to quote.
    throw new RuntimeStartFailedError("The runtime could not be started", undefined, {
      cause: error,
    });
  }
  try {
    const [output, stderr, exitCode] = await withDeadline(
      Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]),
      VERSION_PROBE_TIMEOUT_MS,
      () => new RuntimeStartFailedError("The runtime did not answer its version check in time"),
    );
    if (exitCode !== 0)
      throw new RuntimeStartFailedError(
        `The runtime exited ${exitCode} when asked for its version`,
        stderrHint(stderr),
      );
    return versionFrom(output);
  } catch (error) {
    if (error instanceof RuntimeStartFailedError) throw error;
    throw new RuntimeStartFailedError("The runtime could not be started", stderrHint(""), {
      cause: error,
    });
  } finally {
    child.kill();
  }
}

/** The first non-blank stderr line, redacted and bounded — the one line a person needs. */
export function stderrHint(stderr: string): string | undefined {
  const line = stderr.split("\n").find((candidate) => candidate.trim().length > 0);
  return line === undefined ? undefined : scrubStderrHint(line);
}
