import { VERSION_PROBE_TIMEOUT_MS, withDeadline } from "@lrm/coforge-anvil";

/** Reads `[...command, "--version"]`, killing the child if it outlives the probe budget. */
export async function readVersionOutput(
  command: readonly string[],
  versionFrom: (output: string) => string | undefined,
): Promise<string | undefined> {
  const child = Bun.spawn({ cmd: [...command, "--version"], stdout: "pipe", stderr: "ignore" });
  try {
    const [output, exitCode] = await withDeadline(
      Promise.all([new Response(child.stdout).text(), child.exited]),
      VERSION_PROBE_TIMEOUT_MS,
      () => new Error("runtime version probe timed out"),
    );
    return exitCode === 0 ? versionFrom(output) : undefined;
  } finally {
    child.kill();
  }
}
