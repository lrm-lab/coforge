import { randomBytes } from "node:crypto";

import { AppError } from "#src/lib/app-error";
import { APP_LOGO_UPLOAD_TYPES } from "#src/lib/image-upload";
import type { FileStorage } from "#src/server/files/file-storage.server";
import { validateImage } from "#src/server/files/image-upload.server";
import { replaceStoredImage } from "#src/server/files/stored-image-replacement.server";
import type { AppCategory } from "#src/features/apps/app-category";
import {
  APP_INPUT_ERROR_IDS,
  appKeyFromName,
  checkAppInput,
  type AppInputField,
  type AppPatch,
  type AppRegistrationInput,
} from "#src/features/apps/app-registration";
import {
  assertCanManageApps,
  type WorkspaceMemberRole,
} from "#src/server/workspaces/member-role.server";
import type { AppPublishStatus } from "#src/features/apps/app-publish-status";
import { mintAppClientSecret } from "./app-client-secret.server";
import { appLogoObjectKey } from "./app-logo.server";

/** A registered app as its Workspace's members see it; never its secret or the secret's hash. */
export type AppView = {
  key: string;
  ownerWorkspaceId: string;
  name: string;
  description: string;
  whenToUse: string;
  homepageUrl: string | null;
  /** The publisher's Agent manifest URL; none is derived from the homepage (`resolveAgentManifest`). */
  agentManifestUrl: string | null;
  redirectUris: string[];
  category: AppCategory;
  allowedScopes: string[];
  /** The logo in the image store; surfaces show `appLogoUrl`, never the key. */
  logoObjectKey: string | null;
  /** Where the app is in Marketplace review (`server/app-marketplace/`). */
  publishStatus: AppPublishStatus;
  secretRotatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/** The member acting, in the Workspace the request names. */
export type AppActor = { workspaceId: string; actorUserId: string };

type AppMember = { role: WorkspaceMemberRole; workspaceSlug: string };

/** Whether `app-agent-manifest` is on for the Workspace. */
export type AgentManifestFlag = (workspace: {
  workspaceId: string;
  workspaceSlug: string;
}) => Promise<boolean>;

/** What a write may set on an app: a checked patch, or a new secret. */
export type AppChange = AppPatch & { clientSecretHash?: string; secretRotatedAt?: Date };

export interface AppRegistryStore {
  /** The person's role and the Workspace's slug (a feature-flag rule may match it); `undefined`
   * for a non-member. */
  findMember(workspaceId: string, userId: string): Promise<AppMember | undefined>;
  /** The apps installed in the Workspace. */
  listForWorkspace(workspaceId: string): Promise<AppView[]>;
  find(key: string): Promise<AppView | undefined>;
  /** Creates the app and installs it in its Workspace, atomically; `undefined` when the key is
   * taken. */
  create(input: {
    app: AppRegistrationInput;
    workspaceId: string;
    userId: string;
    clientSecretHash: string;
  }): Promise<AppView | undefined>;
  /** Both writes touch only the app `key` that `workspaceId` owns, and answer `undefined` /
   * `false` when there is none. */
  update(workspaceId: string, key: string, change: AppChange): Promise<AppView | undefined>;
  /** Deletes the app `key` that `workspaceId` owns, answering the logo its row had as it went
   * (so a logo uploaded since it was read is not left behind); `undefined` when there is none,
   * `"blocked"` when it is published or waiting to leave the Marketplace (`DELETABLE_STATUSES`). */
  delete(
    workspaceId: string,
    key: string,
  ): Promise<{ logoObjectKey: string | null } | "blocked" | undefined>;
  /** Sets the logo of the app `key` that `workspaceId` owns to `to` (none: the monogram), only
   * while it is still `from`; `false` when it is not, or there is no such app. */
  replaceLogo(
    workspaceId: string,
    key: string,
    from: string | null,
    to: { objectKey: string; contentType: string } | null,
  ): Promise<boolean>;
  /** The logo of the app `key` that `workspaceId` owns, when it has one and `viewerUserId` is a
   * member of a Workspace where it is installed. */
  findLogo(input: {
    workspaceId: string;
    key: string;
    viewerUserId: string;
  }): Promise<{ objectKey: string; contentType: string } | undefined>;
}

/** Finds an app's logo for a viewer. */
export type AppLogoLookup = (input: {
  workspaceId: string;
  key: string;
  viewerUserId: string;
}) => Promise<{ objectKey: string; contentType: string } | undefined>;

/** Where the registry keeps logos (the image store, as for Agent avatars), and who hears of an
 * old logo's object that could not be removed after its change was committed. */
export type AppLogoImages = {
  storage(): Promise<FileStorage>;
  removalFailed(error: unknown): void;
};

/** How many keys made from a name are tried before a registration gives up: each
 * has a new random suffix, so a second collision is already unlikely. */
const MADE_KEY_ATTEMPTS = 5;

/** Six random lowercase letters and digits. */
function randomKeySuffix(): string {
  return randomBytes(4).readUInt32BE(0).toString(36).padStart(6, "0").slice(-6);
}

/** The checked input, or INVALID_INPUT naming the field (`app-redirect-uris-invalid`). */
function checked<Value>(
  outcome: { ok: true; value: Value } | { ok: false; field: AppInputField },
): Value {
  if (outcome.ok) return outcome.value;
  throw new AppError("INVALID_INPUT", { errorId: APP_INPUT_ERROR_IDS[outcome.field] });
}

/**
 * The app registry: the third-party apps Workspaces register. Every member lists their
 * Workspace's apps; its owners and admins register its own apps, change them, set or reset their
 * logos, rotate their secrets and delete them. A logo's bytes are in the image store, the row keeps
 * its key, and a replaced, reset or deleted app's object is removed (best effort). Another
 * Workspace's app is NOT_FOUND, and so is a built-in Agent App (the SDK's `BUILT_IN_APPS`): it is
 * not in the registry, and nobody changes it.
 */
export class AppRegistry {
  constructor(
    private readonly store: AppRegistryStore,
    private readonly images: AppLogoImages,
    private readonly options: {
      now?: () => Date;
      /** The random part of a key made for an app registered without one. */
      keySuffix?: () => string;
      /** Whether the Workspace may set an app's Agent manifest URL; off when absent. */
      agentManifestEnabled?: AgentManifestFlag;
      /** A logo the member path does not show: a platform reviewer's view of a pending app's
       * (`server/app-marketplace/`). Asked only after the member path misses. */
      findReviewLogo?: AppLogoLookup;
    } = {},
  ) {}

  /** The Workspace's apps, and whether it shows the Agent manifest URL (`app-agent-manifest`). */
  async listWorkspaceApps(
    actor: AppActor,
  ): Promise<{ apps: AppView[]; manifest: boolean; workspaceSlug: string }> {
    const member = await this.store.findMember(actor.workspaceId, actor.actorUserId);
    if (!member) throw new AppError("ACCESS_DENIED");
    const [apps, manifest] = await Promise.all([
      this.store.listForWorkspace(actor.workspaceId),
      this.manifestAllowed(actor, member),
    ]);
    return { apps, manifest, workspaceSlug: member.workspaceSlug };
  }

  /** Registers the app in the actor's Workspace; its client secret is in the answer and nowhere
   * else. A blank key asks for one made from the app's name; a key the caller chose that is taken
   * is refused, never replaced. */
  async registerApp(
    actor: AppActor,
    input: AppRegistrationInput,
  ): Promise<{ app: AppView; clientSecret: string }> {
    const member = this.appManager(
      await this.store.findMember(actor.workspaceId, actor.actorUserId),
    );
    const chosen = typeof input.key === "string" ? input.key.trim() : input.key;
    const { secret, hash } = mintAppClientSecret();
    const create = (app: AppRegistrationInput) =>
      this.store.create({
        app,
        workspaceId: actor.workspaceId,
        userId: actor.actorUserId,
        clientSecretHash: hash,
      });
    const attempts = chosen === "" ? MADE_KEY_ATTEMPTS : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const key =
        chosen === ""
          ? appKeyFromName(
              typeof input.name === "string" ? input.name : "",
              (this.options.keySuffix ?? randomKeySuffix)(),
            )
          : chosen;
      // A made key already taken is skipped before the insert, so a registration inside a
      // transaction (`AppEditorSave.register`) is not left with a failed statement to retry after.
      if (chosen === "" && (await this.store.find(key))) continue;
      const checkedInput = checked(checkAppInput({ ...input, key }, "registration"));
      await this.assertManifestUrlAllowed(actor, member, checkedInput);
      const created = await create(checkedInput);
      if (created) return { app: created, clientSecret: secret };
    }
    throw new AppError("CONFLICT", { errorId: "app-key-taken" });
  }

  /** Changes the fields `patch` names; never the app's key or owner. */
  async updateApp(actor: AppActor, key: string, patch: AppPatch): Promise<AppView> {
    return (await this.updateAppInWorkspace(actor, key, patch)).app;
  }

  /** `updateApp`, also answering the Workspace's slug (the member lookup already read it), for a
   * caller that checks a flag the slug can decide. */
  async updateAppInWorkspace(
    actor: AppActor,
    key: string,
    patch: AppPatch,
  ): Promise<{ app: AppView; workspaceSlug: string }> {
    const { member } = await this.ownApp(actor, key);
    const change = checked(checkAppInput(patch, "patch"));
    await this.assertManifestUrlAllowed(actor, member, change);
    const app = this.written(await this.store.update(actor.workspaceId, key, change));
    return { app, workspaceSlug: member.workspaceSlug };
  }

  /** Replaces the app's client secret: the old one stops verifying at once, and the new one is in
   * the answer and nowhere else. */
  async rotateAppSecret(
    actor: AppActor,
    key: string,
  ): Promise<{ app: AppView; clientSecret: string }> {
    await this.requireOwnApp(actor, key);
    const { secret, hash } = mintAppClientSecret();
    const app = this.written(
      await this.store.update(actor.workspaceId, key, {
        clientSecretHash: hash,
        secretRotatedAt: (this.options.now ?? (() => new Date()))(),
      }),
    );
    return { app, clientSecret: secret };
  }

  /** Deletes the app and its installation; its secret stops verifying, and its logo goes. An app
   * listed in the Marketplace, or waiting to leave it, is CONFLICT (`app-published-undeletable`). */
  async deleteApp(actor: AppActor, key: string): Promise<void> {
    await this.requireOwnApp(actor, key);
    const deleted = await this.store.delete(actor.workspaceId, key);
    if (deleted === "blocked")
      throw new AppError("CONFLICT", { errorId: "app-published-undeletable" });
    if (!deleted) throw new AppError("NOT_FOUND");
    await this.removeImage(deleted.logoObjectKey);
  }

  /** Replaces the app's logo with `file`, a JPEG, PNG, GIF or WebP within the uploaded-image
   * limit (`validateImage` with `APP_LOGO_UPLOAD_TYPES`), at once; the old logo's object is removed. */
  async setAppLogo(actor: AppActor, key: string, file: File): Promise<AppView> {
    const app = await this.requireOwnApp(actor, key);
    await validateImage(file, APP_LOGO_UPLOAD_TYPES);
    const objectKey = appLogoObjectKey(actor.workspaceId, key);
    await replaceStoredImage({
      storage: await this.images.storage(),
      objectKey,
      file,
      contentType: file.type,
      previousObjectKey: app.logoObjectKey,
      commit: () => this.swapLogo(actor, app, { objectKey, contentType: file.type }),
      reportRemovalFailure: (error) => this.images.removalFailed(error),
    });
    return { ...app, logoObjectKey: objectKey };
  }

  /** Back to the monogram: the logo's object is removed. */
  async resetAppLogo(actor: AppActor, key: string): Promise<AppView> {
    const app = await this.requireOwnApp(actor, key);
    if (app.logoObjectKey) {
      await this.swapLogo(actor, app, null);
      await this.removeImage(app.logoObjectKey);
    }
    return { ...app, logoObjectKey: null };
  }

  /** The logo's bytes, for a member of a Workspace where the app is installed, or a reviewer of a
   * pending request; NOT_FOUND for anyone else, as for an app with no logo. */
  async readAppLogo(viewerUserId: string, workspaceId: string, key: string) {
    const input = { workspaceId, key, viewerUserId };
    const logo =
      (await this.store.findLogo(input)) ??
      (await (this.options.findReviewLogo ?? (async () => undefined))(input));
    const file = logo ? await (await this.images.storage()).open(logo.objectKey) : null;
    if (!logo || !file) throw new AppError("NOT_FOUND");
    return { body: file.body, contentType: logo.contentType };
  }

  /**
   * The actor may manage apps, and `key` is their Workspace's own app, which is the answer. The role and the app are
   * read together, then judged in this order, so a role without the right is always ACCESS_DENIED;
   * another Workspace's app is NOT_FOUND, as is an unknown or built-in key, so another Workspace's
   * app is not confirmed to exist.
   */
  async requireOwnApp(actor: AppActor, key: string): Promise<AppView> {
    return (await this.ownApp(actor, key)).app;
  }

  private async ownApp(actor: AppActor, key: string) {
    const [found, app] = await Promise.all([
      this.store.findMember(actor.workspaceId, actor.actorUserId),
      this.store.find(key),
    ]);
    const member = this.appManager(found);
    if (!app || app.ownerWorkspaceId !== actor.workspaceId) throw new AppError("NOT_FOUND");
    return { app, member };
  }

  /** Moves the app's logo from the one `app` was read with to `to`, leaving the old object to the
   * caller; CONFLICT when another change came first, NOT_FOUND when the app went. */
  private async swapLogo(
    actor: AppActor,
    app: AppView,
    to: { objectKey: string; contentType: string } | null,
  ): Promise<void> {
    if (!(await this.store.replaceLogo(actor.workspaceId, app.key, app.logoObjectKey, to))) {
      const current = await this.store.find(app.key);
      throw new AppError(
        current?.ownerWorkspaceId === actor.workspaceId ? "CONFLICT" : "NOT_FOUND",
      );
    }
  }

  /** The change is already committed, so a failed removal is reported, never thrown. */
  private async removeImage(objectKey: string | null): Promise<void> {
    if (!objectKey) return;
    try {
      await (await this.images.storage()).remove(objectKey);
    } catch (error) {
      this.images.removalFailed(error);
    }
  }

  /** Setting an Agent manifest URL is refused where `app-agent-manifest` is off; clearing it is not. */
  private async assertManifestUrlAllowed(
    actor: AppActor,
    member: AppMember,
    change: AppPatch,
  ): Promise<void> {
    if (!change.agentManifestUrl || (await this.manifestAllowed(actor, member))) return;
    throw new AppError("ACCESS_DENIED", { errorId: "app-agent-manifest-off" });
  }

  /** The actor as a member who may manage apps. */
  private appManager(member: AppMember | undefined): AppMember {
    assertCanManageApps(member?.role);
    if (!member) throw new AppError("ACCESS_DENIED");
    return member;
  }

  private async manifestAllowed(actor: AppActor, member: AppMember): Promise<boolean> {
    const flag = this.options.agentManifestEnabled;
    return flag
      ? flag({ workspaceId: actor.workspaceId, workspaceSlug: member.workspaceSlug })
      : false;
  }

  /** A write's answer; none means the app went in between. */
  private written(app: AppView | undefined): AppView {
    if (!app) throw new AppError("NOT_FOUND");
    return app;
  }
}
