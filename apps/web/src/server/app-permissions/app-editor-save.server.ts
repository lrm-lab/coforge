import type { AppPermissionsView, AppPermissions } from "./app-permissions.server";
import type {
  AppInstallationSetup,
  AppSetupView,
} from "#src/server/app-installation-setup/app-installation-setup.server";
import type { AppPatch, AppRegistrationInput } from "#src/features/apps/app-registration";
import type { AppActor, AppRegistry, AppView } from "#src/server/apps/app-registry.server";

/** The modules a Save writes through, all on the one open transaction. */
export type AppEditorScope = {
  registry: AppRegistry;
  permissions: AppPermissions;
  setup: AppInstallationSetup;
};

/** What a Save changes: the profile `patch`, and the data `permissionGroups` and `setup` page it
 * declares (as the declaring modules take them), when the editor shows them. */
export type AppEditorChange = {
  patch: AppPatch;
  permissionGroups?: unknown;
  /** The notification events subscribed to, declared with the groups (`app-notifications`). */
  notificationEvents?: unknown;
  setup?: unknown;
};

/** What a registration declares beyond the profile, as the declaring modules take them. */
export type AppEditorDeclarations = Pick<
  AppEditorChange,
  "permissionGroups" | "notificationEvents" | "setup"
>;

/** What the editor's Save answers with: the app and, while their flags are on, its data
 * permissions and setup in the actor's Workspace. */
export type AppEditorSaved = {
  app: AppView;
  permissions: AppPermissionsView | null;
  setup: AppSetupView | null;
};

/**
 * Saving an app in the editor: its profile fields and, where the editor shows them, the data
 * groups it declares and the page it is set up on. The application use case that owns the Save, so
 * they are one change: a refusal by any (a patch field, the groups, the setup, a role, a flag) rolls
 * all back, with the revision bumps and the narrowed approvals of a declaration.
 */
export class AppEditorSave {
  constructor(
    /** Runs `work` in one transaction over a registry and a permissions module that share it. */
    private readonly transaction: <Result>(
      work: (scope: AppEditorScope) => Promise<Result>,
    ) => Promise<Result>,
  ) {}

  /** Declares `permissionGroups` when given (refused where `app-data-permissions` is off) and
   * `setup` when given (refused where `app-installation-setup` is off), then changes the profile
   * fields `patch` names. `permissions` and `setup` are `null` while their flags are off. */
  async save(actor: AppActor, key: string, change: AppEditorChange): Promise<AppEditorSaved> {
    return this.transaction(async ({ registry, permissions, setup }) => {
      const declared =
        change.permissionGroups === undefined
          ? undefined
          : await permissions.declare(
              actor,
              key,
              change.permissionGroups,
              change.notificationEvents,
            );
      const declaredSetup =
        change.setup === undefined ? undefined : await setup.declare(actor, key, change.setup);
      const app = await registry.updateApp(actor, key, change.patch);
      return {
        app,
        permissions: declared ?? (await permissions.appPermissions(actor, key)),
        setup: declaredSetup ?? (await setup.appSetup(actor, key)),
      };
    });
  }

  /**
   * Registers an app with the groups and setup page it declares: one change like `save`, so a
   * refusal of any part registers nothing. The registering Workspace's installation starts with the
   * declared groups pending approval (`AppPermissions.approve` is a separate act); the answer
   * carries the client secret, once.
   */
  async register(
    actor: AppActor,
    input: AppRegistrationInput,
    declarations: AppEditorDeclarations,
  ): Promise<AppEditorSaved & { clientSecret: string }> {
    return this.transaction(async ({ registry, permissions, setup }) => {
      const { app, clientSecret } = await registry.registerApp(actor, input);
      const declared =
        declarations.permissionGroups === undefined
          ? undefined
          : await permissions.declare(
              actor,
              app.key,
              declarations.permissionGroups,
              declarations.notificationEvents,
            );
      const declaredSetup =
        declarations.setup === undefined
          ? undefined
          : await setup.declare(actor, app.key, declarations.setup);
      return {
        app,
        clientSecret,
        permissions: declared ?? (await permissions.appPermissions(actor, app.key)),
        setup: declaredSetup ?? (await setup.appSetup(actor, app.key)),
      };
    });
  }
}
