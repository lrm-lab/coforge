import { RuntimeStartFailedError, RuntimeVersionUnsupportedError } from "#src/contract";
import type { CliVersionReader } from "#src/version-gate";

/** Preview ACP is deliberately pinned: unknown/newer releases require native acceptance. */
export const DSH_ACP_VERSION = "0.2.1-rc.2";

export function dshVersionFromOutput(output: string): string | undefined {
  const version = output.trim();
  return /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version) ? version : undefined;
}

export async function assertDshVersion(
  command: readonly string[],
  versionReader: CliVersionReader,
): Promise<void> {
  let version: string | undefined;
  try {
    version = await versionReader(command, dshVersionFromOutput);
  } catch (error) {
    // Unlike the shared minimum-version policy, unreadable preview versions fail closed — but a
    // CLI that could not start at all is reported as that, never as a version judgement.
    if (error instanceof RuntimeStartFailedError) throw error;
    throw new RuntimeStartFailedError(
      "DeepSeek Harness could not be started; check that its executable runs on this Computer",
      undefined,
      { cause: error },
    );
  }
  if (version === DSH_ACP_VERSION) return;
  throw new RuntimeVersionUnsupportedError(
    `DeepSeek Harness version is unsupported or unknown; requires exactly ${DSH_ACP_VERSION}. ` +
      `Install @deepseek-ai/dsh@${DSH_ACP_VERSION} before starting this runtime.`,
  );
}
