import { hasErrorCode } from "@lrm/coforge-sdk/internal";

/** The spawner could not find a runtime executable on the PATH the Agent launches with. Thrown
 * only for the executable itself; any other `ENOENT` while spawning (a missing working directory)
 * stays the plain spawn error. */
export class RuntimeExecutableNotFoundError extends Error {
  readonly code = "runtime_not_found";
  constructor(
    readonly executable: string,
    options?: ErrorOptions,
  ) {
    super(`Executable not found in $PATH: "${executable}"`, options);
    this.name = "RuntimeExecutableNotFoundError";
  }
}

/** Runs `spawn`; a spawn `ENOENT` for an executable the Agent's PATH cannot resolve becomes a
 * `RuntimeExecutableNotFoundError`. Any other `ENOENT` (a missing working directory) is rethrown
 * as it is. */
export function spawnRuntime<T>(
  command: readonly string[],
  cwd: string,
  environment: Readonly<Record<string, string>>,
  spawn: () => T,
): T {
  try {
    return spawn();
  } catch (error) {
    const executable = command[0] ?? "";
    if (
      hasErrorCode(error, "ENOENT") &&
      !Bun.which(executable, { cwd, PATH: environment.PATH ?? "" })
    )
      throw new RuntimeExecutableNotFoundError(executable, { cause: error });
    throw error;
  }
}
