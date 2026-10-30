import { AppError } from "#src/lib/app-error";
import { assertCanManageWorkspaceSettings } from "#src/server/workspaces/member-role.server";
import type {
  FeatureFlag,
  FeatureFlagContext,
} from "#src/server/feature-flags/feature-flags.server";

/**
 * The experiments a Workspace's owner or admin can switch on in Settings. The flag decides which
 * Workspaces offer one; the Workspace's own switch decides whether it applies to everyone in it
 * and to every Agent. Graduating an experiment removes its entry here and its flag: a stored
 * choice for a key that is no longer listed is ignored, so no dead switch is left behind.
 *
 * `reload` says a change only takes full effect after the page reloads or reconnects.
 */
export const EXPERIMENTS = {
  taskConversations: { flag: "task-conversations", reload: false },
} as const satisfies Record<string, { flag: FeatureFlag; reload: boolean }>;

export type ExperimentKey = keyof typeof EXPERIMENTS;

export type ExperimentView = { key: ExperimentKey; enabled: boolean; reload: boolean };

export type ExperimentsRepository = {
  read(workspaceId: string): Promise<Record<string, boolean>>;
  write(workspaceId: string, key: string, enabled: boolean): Promise<void>;
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

  /** The experiments this Workspace offers, with its switch for each. */
  async list(workspace: FeatureFlagContext): Promise<ExperimentView[]> {
    const stored = await this.repository.read(workspace.workspaceId);
    const offered = await Promise.all(
      EXPERIMENT_KEYS.map(async (key) =>
        (await this.flagEnabled(EXPERIMENTS[key].flag, workspace)) ? key : null,
      ),
    );
    return offered
      .filter((key) => key !== null)
      .map((key) => ({ key, enabled: stored[key] === true, reload: EXPERIMENTS[key].reload }));
  }

  /** On when the Workspace offers it and its owner or an admin switched it on. */
  async enabled(key: ExperimentKey, workspace: FeatureFlagContext) {
    if (!(await this.flagEnabled(EXPERIMENTS[key].flag, workspace))) return false;
    return (await this.repository.read(workspace.workspaceId))[key] === true;
  }

  /**
   * Switches an experiment for the whole Workspace: its owner or an admin only. A key the
   * Workspace does not offer is NOT_FOUND, as if it did not exist.
   */
  async set(
    workspace: FeatureFlagContext,
    actorRole: string | undefined,
    key: ExperimentKey,
    enabled: boolean,
  ): Promise<ExperimentView> {
    assertCanManageWorkspaceSettings(actorRole);
    if (!(await this.flagEnabled(EXPERIMENTS[key].flag, workspace)))
      throw new AppError("NOT_FOUND");
    await this.repository.write(workspace.workspaceId, key, enabled);
    return { key, enabled, reload: EXPERIMENTS[key].reload };
  }
}
