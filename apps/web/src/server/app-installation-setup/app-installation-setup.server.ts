import { AppError } from "#src/lib/app-error";
import {
  APP_INSTALLATION_SETUP_OFF,
  APP_SETUP_ERROR_IDS,
  checkSetupInput,
  setupLink,
  setupStatus,
  type SetupStatus,
} from "#src/features/apps/app-installation-setup";
import type { AppActor } from "#src/server/apps/app-registry.server";
import { canManageApps } from "#src/features/workspaces/workspace-roles";
import {
  assertCanManageApps,
  type WorkspaceMemberRole,
} from "#src/server/workspaces/member-role.server";

/** An app installed in a Workspace, with the setup it declares and what that installation finished. */
export type InstallationSetupRow = {
  installationId: string;
  appKey: string;
  ownerWorkspaceId: string;
  workspaceId: string;
  workspaceSlug: string;
  url: string | null;
  description: string;
  /** The app's setup revision. */
  revision: number;
  completedRevision: number | null;
  completedAt: Date | null;
};

/** An installation's setup with what follows from it. */
export type AppSetupView = {
  installationId: string;
  workspaceId: string;
  status: SetupStatus;
  url: string | null;
  /** `url` with the installation's ids, once a person who may open it asked; else null. */
  link: string | null;
  description: string;
  revision: number;
  completedAt: Date | null;
};

export interface AppInstallationSetupStore {
  /** The person's role in the Workspace, and the Workspace's slug, which a flag rule may match. */
  findMember(
    workspaceId: string,
    userId: string,
  ): Promise<{ role: WorkspaceMemberRole; workspaceSlug: string } | undefined>;
  listInstalled(workspaceId: string): Promise<InstallationSetupRow[]>;
  /** The installation of the app `key` in `workspaceId`. */
  findInstalled(workspaceId: string, key: string): Promise<InstallationSetupRow | undefined>;
  findInstallation(id: string): Promise<InstallationSetupRow | undefined>;
  /** Declares the page and description of the app `key` that `ownerWorkspaceId` owns, in one
   * statement: the revision goes up by one exactly when `url` differs from the stored one (null
   * included). `false` when there is no such app. */
  declare(input: {
    ownerWorkspaceId: string;
    key: string;
    url: string | null;
    description: string;
  }): Promise<boolean>;
  /** Records the installation as finished (`at`, kept if it already was) or not, for `revision`,
   * only while the app is still at that revision and has a page. `false` when it is not, and
   * nothing is written. */
  record(input: {
    installationId: string;
    revision: number;
    complete: boolean;
    at: Date;
  }): Promise<boolean>;
}

/** Whether the `app-installation-setup` flag is on for the Workspace. */
export type InstallationSetupFlag = (workspace: {
  workspaceId: string;
  workspaceSlug: string;
}) => Promise<boolean>;

export type SetupReportOutcome =
  | { outcome: "recorded"; setup: AppSetupView }
  /** The app declared a new revision since the one reported. */
  | { outcome: "stale" }
  | { outcome: "not_required" }
  | { outcome: "not_found" };

const OFF = () => new AppError("ACCESS_DENIED", { errorId: APP_INSTALLATION_SETUP_OFF });

function viewOf(setup: InstallationSetupRow, withLink: boolean): AppSetupView {
  return {
    installationId: setup.installationId,
    workspaceId: setup.workspaceId,
    status: setupStatus({
      url: setup.url,
      revision: setup.revision,
      completedRevision: setup.completedRevision,
    }),
    url: setup.url,
    link:
      withLink && setup.url !== null
        ? setupLink(setup.url, {
            installationId: setup.installationId,
            workspaceId: setup.workspaceId,
            revision: setup.revision,
          })
        : null,
    description: setup.description,
    revision: setup.revision,
    completedAt: setup.completedRevision === setup.revision ? setup.completedAt : null,
  };
}

/**
 * Where an app is set up after it is installed, behind the `app-installation-setup` flag. The
 * registering Workspace's owners and admins declare the page and what it is for; the app's backend
 * reports, per installation, that it finished (or no longer has finished) the revision it was
 * given. The revision goes up only when the page changes, setup being turned on or off included,
 * so a finished setup stays finished when only the description changes, and a new page, or setup
 * turned back on, asks every installation again. Completion belongs to one installation, so a new
 * installation starts pending. With the flag off nothing is shown and nothing changes.
 */
export class AppInstallationSetup {
  constructor(
    private readonly store: AppInstallationSetupStore,
    private readonly flagOn: InstallationSetupFlag,
    /** Settles that `key` is the actor's Workspace's own app and the actor may manage apps
     * (`AppRegistry.requireOwnApp`); throws otherwise. */
    private readonly requireOwnApp: (actor: AppActor, key: string) => Promise<unknown>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** The setup of every app installed in the actor's Workspace, by key; `null` while the flag is
   * off there. Only owners and admins get the link to open. */
  async workspaceSetups(actor: AppActor): Promise<Map<string, AppSetupView> | null> {
    const member = await this.enabledMember(actor);
    if (!member) return null;
    const apps = await this.store.listInstalled(actor.workspaceId);
    return new Map(apps.map((app) => [app.appKey, viewOf(app, canManageApps(member.role))]));
  }

  /** The setup of app `key` installed in the actor's Workspace; `null` while the flag is off. */
  async appSetup(actor: AppActor, key: string): Promise<AppSetupView | null> {
    const member = await this.enabledMember(actor);
    if (!member) return null;
    return viewOf(await this.requireInstalled(actor, key), canManageApps(member.role));
  }

  /** Declares the page and description of the Workspace's own app `key` (`input` is as
   * `checkSetupInput` takes it). Run in a transaction with the app's other changes
   * (`AppEditorSave`) when they must stand or fall together. */
  async declare(actor: AppActor, key: string, input: unknown): Promise<AppSetupView> {
    const member = await this.enabledMember(actor);
    if (!member) throw OFF();
    assertCanManageApps(member.role);
    const checked = checkSetupInput(input);
    if (!checked.ok)
      throw new AppError("INVALID_INPUT", { errorId: APP_SETUP_ERROR_IDS[checked.field] });
    await this.requireOwnApp(actor, key);
    const written = await this.store.declare({
      ownerWorkspaceId: actor.workspaceId,
      key,
      ...checked.value,
    });
    if (!written) throw new AppError("NOT_FOUND");
    return viewOf(await this.requireInstalled(actor, key), true);
  }

  /** An installation's setup, for its app: the link is always there. */
  async read(installationId: string): Promise<AppSetupView | undefined> {
    const setup = await this.store.findInstallation(installationId);
    return setup && viewOf(setup, true);
  }

  /** The installation of the app `appKey` in `workspaceId`, with its setup; none while the flag is
   * off there, as for a Workspace the app is not installed in. */
  async lookup(appKey: string, workspaceId: string): Promise<AppSetupView | undefined> {
    const setup = await this.store.findInstalled(workspaceId, appKey);
    if (!setup || !(await this.flagOn(setup))) return undefined;
    return viewOf(setup, true);
  }

  /** The app's report that the installation finished (`complete`) or did not finish (`pending`)
   * the setup at `revision`. Repeating a report changes nothing; a revision the app has moved on
   * from, or an app with no setup page, is refused. */
  async report(
    installationId: string,
    report: { revision: number; status: "pending" | "complete" },
  ): Promise<SetupReportOutcome> {
    const setup = await this.store.findInstallation(installationId);
    if (!setup) return { outcome: "not_found" };
    const refusal = this.refusal(setup, report.revision);
    if (refusal) return refusal;
    const complete = report.status === "complete";
    const at = this.now();
    const written = await this.store.record({
      installationId,
      revision: report.revision,
      complete,
      at,
    });
    if (written)
      // The write held the revision and the page, so the row is the one read with the report in it.
      return {
        outcome: "recorded",
        setup: viewOf(
          {
            ...setup,
            completedRevision: complete ? report.revision : null,
            completedAt: complete
              ? setup.completedRevision === report.revision
                ? setup.completedAt
                : at
              : null,
          },
          true,
        ),
      };
    // The app declared again between the read and the write.
    const current = await this.store.findInstallation(installationId);
    if (!current) return { outcome: "not_found" };
    return this.refusal(current, report.revision) ?? { outcome: "stale" };
  }

  private refusal(setup: InstallationSetupRow, revision: number) {
    if (setup.url === null) return { outcome: "not_required" } as const;
    if (setup.revision !== revision) return { outcome: "stale" } as const;
    return undefined;
  }

  private async requireInstalled(actor: AppActor, key: string): Promise<InstallationSetupRow> {
    const setup = await this.store.findInstalled(actor.workspaceId, key);
    if (!setup) throw new AppError("NOT_FOUND");
    return setup;
  }

  /** The actor's role, when they are a member of a Workspace where the flag is on; `null` while it
   * is off there. */
  private async enabledMember(actor: AppActor): Promise<{ role: WorkspaceMemberRole } | null> {
    const member = await this.store.findMember(actor.workspaceId, actor.actorUserId);
    if (!member) throw new AppError("ACCESS_DENIED");
    const on = await this.flagOn({
      workspaceId: actor.workspaceId,
      workspaceSlug: member.workspaceSlug,
    });
    return on ? member : null;
  }
}
