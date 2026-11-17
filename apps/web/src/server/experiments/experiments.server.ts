import { AppError } from "#src/lib/app-error";
import { assertCanManageWorkspaceSettings } from "#src/server/workspaces/member-role.server";
import type {
  FeatureFlag,
  FeatureFlagContext,
} from "#src/server/feature-flags/feature-flags.server";
export const EXPERIMENTS = {
  taskConversations: { flag: null, defaultEnabled: false, reload: false },
  drafts: { flag: null, defaultEnabled: true, reload: false },
  artifacts: { flag: null, defaultEnabled: false, reload: false },
  aiWorkbench: { flag: null, defaultEnabled: true, reload: false },
  teamMemory: { flag: null, defaultEnabled: true, reload: false },
} as const satisfies Record<
  string,
  {
    flag: FeatureFlag | null;
    defaultEnabled: boolean;
    reload: boolean;
  }
>;
export type ExperimentKey = keyof typeof EXPERIMENTS;
export type ExperimentView = {
  key: ExperimentKey;
  enabled: boolean;
  reload: boolean;
};
export type ExperimentsRepository = {
  read(workspaceId: string): Promise<Record<string, boolean>>;
  write(workspaceId: string, key: string, enabled: boolean): Promise<void>;
};
export const EXPERIMENT_KEYS = Object.keys(EXPERIMENTS) as [ExperimentKey, ...ExperimentKey[]];
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
  private async offered(key: ExperimentKey, workspace: FeatureFlagContext) {
    const { flag } = EXPERIMENTS[key];
    return flag === null || (await this.flagEnabled(flag, workspace));
  }
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
  async enabled(key: ExperimentKey, workspace: FeatureFlagContext) {
    if (!(await this.offered(key, workspace))) return false;
    return (
      (await this.repository.read(workspace.workspaceId))[key] ?? EXPERIMENTS[key].defaultEnabled
    );
  }
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
