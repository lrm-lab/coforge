import { DefaultLogger } from "@openfeature/core";
import { MemoryStorage } from "@openfeature/flagd-core";

export type FeatureFlagsConfiguration =
  | { status: "disabled" }
  | { status: "configured"; definitionsPath: string };

/** The flag definition file is unusable, which fails the boot. Messages name the variable and
 * what is wrong, never the file's contents. */
export class FeatureFlagsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeatureFlagsConfigError";
  }
}

const FLAGS_FILE_VARIABLE = "COFORGE_FEATURE_FLAGS_FILE";

/** An unset (or blank) path means this deployment has no flag file and every flag is off; a set
 * path whose file is missing, unreadable, or not a valid flagd flag definition file throws
 * `FeatureFlagsConfigError`, which fails the boot. The check is strict where the provider is
 * lenient: flagd's in-process provider loads a file that breaks its schema and only logs it. */
export async function readFeatureFlagsConfiguration(
  environment: NodeJS.ProcessEnv,
): Promise<FeatureFlagsConfiguration> {
  const definitionsPath = environment[FLAGS_FILE_VARIABLE]?.trim();
  if (!definitionsPath) return { status: "disabled" };
  let definitions: string;
  try {
    definitions = await Bun.file(definitionsPath).text();
  } catch {
    throw new FeatureFlagsConfigError(`${FLAGS_FILE_VARIABLE} names no readable file`);
  }
  try {
    // `setConfigurations`' second argument (strict schema validation) is declared in flagd-core's
    // types (storage.d.ts) but not in its README; the boot test fails if it stops validating.
    new MemoryStorage(new DefaultLogger()).setConfigurations(definitions, true);
  } catch {
    throw new FeatureFlagsConfigError(
      `${FLAGS_FILE_VARIABLE} is not a valid flagd flag definition file (https://flagd.dev/reference/flag-definitions/)`,
    );
  }
  return { status: "configured", definitionsPath };
}
