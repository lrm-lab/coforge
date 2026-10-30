import { AppError } from "#src/lib/app-error";
import type {
  FeatureFlag,
  FeatureFlagContext,
} from "#src/server/feature-flags/feature-flags.server";

/**
 * The experiments a user can switch on in Settings. The flag decides which Workspaces offer one;
 * the user's own switch decides whether it applies to them (and to the Agents they own). Graduating
 * an experiment removes its entry here and its flag: a stored choice for a key that is no longer
 * listed is ignored, so no dead switch is left behind.
 *
 * `reload` says a change only takes full effect after the page reloads or reconnects.
 */
export const EXPERIMENTS = {
  taskConversations: { flag: "task-conversations", reload: false },
} as const satisfies Record<string, { flag: FeatureFlag; reload: boolean }>;

export type ExperimentKey = keyof typeof EXPERIMENTS;

export type ExperimentView = { key: ExperimentKey; enabled: boolean; reload: boolean };

export type ExperimentsRepository = {
  read(userId: string): Promise<Record<string, boolean>>;
  write(userId: string, key: string, enabled: boolean): Promise<void>;
};

export const EXPERIMENT_KEYS = Object.keys(EXPERIMENTS) as [ExperimentKey, ...ExperimentKey[]];

export class Experiments {
  constructor(
    private readonly repository: ExperimentsRepository,
    private readonly flagEnabled: (
      flag: FeatureFlag,
      context: FeatureFlagContext,
    ) => Promise<boolean>,
  ) {}

  /** The experiments this Workspace offers, with the user's switch for each. */
  async list(userId: string, workspace: FeatureFlagContext): Promise<ExperimentView[]> {
    const stored = await this.repository.read(userId);
    const offered = await Promise.all(
      EXPERIMENT_KEYS.map(async (key) =>
        (await this.flagEnabled(EXPERIMENTS[key].flag, workspace)) ? key : null,
      ),
    );
    return offered
      .filter((key) => key !== null)
      .map((key) => ({ key, enabled: stored[key] === true, reload: EXPERIMENTS[key].reload }));
  }

  /** On when the Workspace offers it and the user switched it on. */
  async enabled(key: ExperimentKey, userId: string, workspace: FeatureFlagContext) {
    if (!(await this.flagEnabled(EXPERIMENTS[key].flag, workspace))) return false;
    return (await this.repository.read(userId))[key] === true;
  }

  /** A key the Workspace does not offer is NOT_FOUND, as if it did not exist. */
  async set(
    userId: string,
    workspace: FeatureFlagContext,
    key: ExperimentKey,
    enabled: boolean,
  ): Promise<ExperimentView> {
    if (!(await this.flagEnabled(EXPERIMENTS[key].flag, workspace)))
      throw new AppError("NOT_FOUND");
    await this.repository.write(userId, key, enabled);
    return { key, enabled, reload: EXPERIMENTS[key].reload };
  }
}
