import type { AppPermissionsView, AppPermissions } from "./app-permissions.server";
import type { AppPatch } from "#src/features/apps/app-registration";
import type { AppActor, AppRegistry, AppView } from "#src/server/apps/app-registry.server";

/** The two modules a Save writes through, both on the one open transaction. */
export type AppEditorScope = { registry: AppRegistry; permissions: AppPermissions };

/**
 * Saving an app in the editor: its profile fields and, where the editor shows them, the data
 * groups it declares. The application use case that owns the Save, so the two are one change: a
 * refusal by either (a patch field, the groups, a role, the flag) rolls both back, with the
 * revision bump and the narrowed approvals of a declaration.
 */
export class AppEditorSave {
  constructor(
    /** Runs `work` in one transaction over a registry and a permissions module that share it. */
    private readonly transaction: <Result>(
      work: (scope: AppEditorScope) => Promise<Result>,
    ) => Promise<Result>,
  ) {}

  /** Declares `groups` when given (refused where `app-data-permissions` is off), then changes the
   * profile fields `patch` names. `permissions` is `null` while the flag is off. */
  async save(
    actor: AppActor,
    key: string,
    patch: AppPatch,
    groups?: unknown,
  ): Promise<{ app: AppView; permissions: AppPermissionsView | null }> {
    return this.transaction(async ({ registry, permissions }) => {
      const declared =
        groups === undefined ? undefined : await permissions.declare(actor, key, groups);
      const app = await registry.updateApp(actor, key, patch);
      return { app, permissions: declared ?? (await permissions.appPermissions(actor, key)) };
    });
  }
}
