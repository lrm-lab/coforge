import { AppError } from "#src/lib/app-error";
import { assertCanManageWorkspaceSettings } from "#src/server/workspaces/member-role.server";
import type {
  FeatureFlag,
  FeatureFlagContext,
} from "#src/server/feature-flags/feature-flags.server";

/**
 * The experiments a Workspace's owner or admin can switch in Settings. A flag decides which
 * Workspaces offer one; an entry with no flag (`flag: null`) is offered to every Workspace. The
 * Workspace's own switch decides whether it applies to everyone in it and to every Agent, and
 * `defaultEnabled` is what applies until the switch is first used. Graduating an experiment
 * removes its entry here and its flag: a stored choice for a key that is no longer listed is
 * ignored, so no dead switch is left behind.
 *
 * `reload` says a change only takes full effect after the page reloads or reconnects.
 */
export const EXPERIMENTS = {
  taskConversations: { flag: "task-conversations", defaultEnabled: false, reload: false },
  drafts: { flag: null, defaultEnabled: true, reload: false },
  artifacts: { flag: "artifacts", defaultEnabled: false, reload: false },
} as const satisfies Record<
  string,
  { flag: FeatureFlag | null; defaultEnabled: boolean; reload: boolean }
>;

export type ExperimentKey = keyof typeof EXPERIMENTS;

export type ExperimentView = { key: ExperimentKey; enabled: boolean; reload: boolean };

export type ExperimentsRepository = {
  read(workspaceId: string): Promise<Record<string, boolean>>;
  write(workspaceId: string, key: string, enabled: boolean): Promise<void>;
};

export const EXPERIMENT_KEYS = Object.keys(EXPERIMENTS) as [ExperimentKey, ...ExperimentKey[]];

/** What must hold before an experiment is switched on; a refusal is thrown. */
export type ExperimentPreconditions = Partial<
  Record<ExperimentKey, (workspaceId: string) => Promise<void>>
>;

export class Experiments {
  constructor(
    private readonly repository: ExperimentsRepository,
    private readonly flagEnabled: (
      flag: FeatureFlag,
      context: FeatureFlagContext,
    ) => Promise<boolean>,
    private readonly beforeEnable: ExperimentPreconditions = {},
  ) {}

  /** Whether the Workspace offers the experiment: always when it has no flag. */
  private async offered(key: ExperimentKey, workspace: FeatureFlagContext) {
    const { flag } = EXPERIMENTS[key];
    return flag === null || (await this.flagEnabled(flag, workspace));
  }

  /** The experiments this Workspace offers, with its switch for each. */
  async list(workspace: FeatureFlagContext): Promise<ExperimentView[]> {
    const [stored, offered] = await Promise.all([
      this.repository.read(workspace.workspaceId),
      Promise.all(
        EXPERIMENT_KEYS.map(async (key) => ((await this.offered(key, workspace)) ? key : null)),
      ),
    ]);
    return offered
      .filter((key) => key !== null)
      .map((key) => ({
        key,
        enabled: stored[key] ?? EXPERIMENTS[key].defaultEnabled,
        reload: EXPERIMENTS[key].reload,
      }));
  }

  /** On when the Workspace offers it and its choice, or failing that the experiment's default, is on. */
  async enabled(key: ExperimentKey, workspace: FeatureFlagContext) {
    if (!(await this.offered(key, workspace))) return false;
    return (
      (await this.repository.read(workspace.workspaceId))[key] ?? EXPERIMENTS[key].defaultEnabled
    );
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
    if (!(await this.offered(key, workspace))) throw new AppError("NOT_FOUND");
    if (enabled) await this.beforeEnable[key]?.(workspace.workspaceId);
    await this.repository.write(workspace.workspaceId, key, enabled);
    return { key, enabled, reload: EXPERIMENTS[key].reload };
  }
}
