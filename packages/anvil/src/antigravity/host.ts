import type { PerTurnSessionHost } from "#src/per-turn/session";
import type { CliVersionReader } from "#src/version-gate";
import type { CatalogCommandRunner } from "#src/catalog-command";

/** The host owns I/O; the adapter applies the SSH policy once to each input. */
export interface AntigravityRuntimeHost {
  readonly sessionHost: PerTurnSessionHost;
  readonly versionReader: CliVersionReader;
  readonly catalogCommandRunner: CatalogCommandRunner;
  /** Called at usage-read time, never cached during provider construction. */
  readUsageEnvironment(): Readonly<Record<string, string | undefined>>;
}
export interface AntigravityProviderOptions {
  readonly host: AntigravityRuntimeHost;
  readonly command?: readonly string[];
}
