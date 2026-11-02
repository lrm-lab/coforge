import { RuntimeStartFailedError, RuntimeVersionUnsupportedError } from "#src/contract";
import type { CliVersionReader } from "#src/version-gate";

/**
 * The first verified preview of the 0.2.1 line. The adapter accepts 0.2.1-rc.2 through stable
 * 0.2.1; a newer line takes native acceptance before it is added here.
 */
export const DSH_ACP_VERSION = "0.2.1-rc.2";

/** The npm range the adapter accepts, written out for the launch error and the docs. */
export const DSH_ACP_VERSION_RANGE = ">=0.2.1-rc.2 <0.2.2";

const dshReleaseLine = /^0\.2\.1(?:-rc\.(\d+))?$/;

export function dshVersionFromOutput(output: string): string | undefined {
  const version = output.trim();
  return /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version) ? version : undefined;
}

/** Whether this is a release of the verified 0.2.1 line, from rc.2 through stable 0.2.1. */
export function isDshVersionSupported(version: string | undefined): boolean {
  if (!version) return false;
  const match = dshReleaseLine.exec(version);
  if (!match) return false;
  // No prerelease suffix means stable 0.2.1, which is newer than every 0.2.1-rc release.
  return match[1] === undefined || Number(match[1]) >= 2;
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
  if (isDshVersionSupported(version)) return;
  throw new RuntimeVersionUnsupportedError(
    `DeepSeek Harness version is unsupported or unknown; requires 0.2.1-rc.2 or later in the ` +
      `0.2.1 line (before 0.2.2). Upgrade @deepseek-ai/dsh before starting this runtime.`,
  );
}
