import { randomBytes } from "node:crypto";

import { AppError } from "#src/lib/app-error";
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
import { appClientSecretMatches, mintAppClientSecret } from "./app-client-secret.server";

/** A registered app as its Workspace's members see it; never its secret or the secret's hash. */
export type AppView = {
  key: string;
  ownerWorkspaceId: string;
  name: string;
  description: string;
  whenToUse: string;
  homepageUrl: string | null;
  redirectUris: string[];
  category: AppCategory;
  allowedScopes: string[];
  secretRotatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/** The member acting, in the Workspace the request names. */
export type AppActor = { workspaceId: string; actorUserId: string };

/** What a write may set on an app: a checked patch, or a new secret. */
export type AppChange = AppPatch & { clientSecretHash?: string; secretRotatedAt?: Date };

export interface AppRegistryStore {
  findMemberRole(workspaceId: string, userId: string): Promise<WorkspaceMemberRole | undefined>;
  /** The apps installed in the Workspace. */
  listForWorkspace(workspaceId: string): Promise<AppView[]>;
  find(key: string): Promise<AppView | undefined>;
  /** The app's client secret hash; `undefined` for an unknown app. */
  findSecretHash(key: string): Promise<string | undefined>;
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
  delete(workspaceId: string, key: string): Promise<boolean>;
}

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
 * Workspace's apps; its owners and admins register its own apps, change them, rotate their secrets
 * and delete them. Another Workspace's app is NOT_FOUND, and so is a built-in Agent App (the SDK's
 * `BUILT_IN_APPS`): it is not in the registry, and nobody changes it.
 */
export class AppRegistry {
  constructor(
    private readonly store: AppRegistryStore,
    private readonly now: () => Date = () => new Date(),
    /** The random part of a key made for an app registered without one. */
    private readonly keySuffix: () => string = randomKeySuffix,
  ) {}

  async listWorkspaceApps(actor: AppActor): Promise<AppView[]> {
    if (!(await this.store.findMemberRole(actor.workspaceId, actor.actorUserId)))
      throw new AppError("ACCESS_DENIED");
    return this.store.listForWorkspace(actor.workspaceId);
  }

  /** Registers the app in the actor's Workspace; its client secret is in the answer and nowhere
   * else. A blank key asks for one made from the app's name; a key the caller chose that is taken
   * is refused, never replaced. */
  async registerApp(
    actor: AppActor,
    input: AppRegistrationInput,
  ): Promise<{ app: AppView; clientSecret: string }> {
    assertCanManageApps(await this.store.findMemberRole(actor.workspaceId, actor.actorUserId));
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
          ? appKeyFromName(typeof input.name === "string" ? input.name : "", this.keySuffix())
          : chosen;
      const created = await create(checked(checkAppInput({ ...input, key }, "registration")));
      if (created) return { app: created, clientSecret: secret };
    }
    throw new AppError("CONFLICT", { errorId: "app-key-taken" });
  }

  /** Changes the fields `patch` names; never the app's key or owner. */
  async updateApp(actor: AppActor, key: string, patch: AppPatch): Promise<AppView> {
    await this.requireOwnApp(actor, key);
    const change = checked(checkAppInput(patch, "patch"));
    return this.written(await this.store.update(actor.workspaceId, key, change));
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
        secretRotatedAt: this.now(),
      }),
    );
    return { app, clientSecret: secret };
  }

  /** Deletes the app and its installation; its secret stops verifying. */
  async deleteApp(actor: AppActor, key: string): Promise<void> {
    await this.requireOwnApp(actor, key);
    if (!(await this.store.delete(actor.workspaceId, key))) throw new AppError("NOT_FOUND");
  }

  /** Whether `presented` is the current client secret of the app `key`. */
  async verifyClientSecret(key: string, presented: string): Promise<boolean> {
    const hash = await this.store.findSecretHash(key);
    return hash !== undefined && appClientSecretMatches(hash, presented);
  }

  /**
   * The actor may manage apps, and `key` is their Workspace's own app. The role and the app are
   * read together, then judged in this order, so a role without the right is always ACCESS_DENIED;
   * another Workspace's app is NOT_FOUND, as is an unknown or built-in key, so another Workspace's
   * app is not confirmed to exist.
   */
  private async requireOwnApp(actor: AppActor, key: string): Promise<void> {
    const [role, app] = await Promise.all([
      this.store.findMemberRole(actor.workspaceId, actor.actorUserId),
      this.store.find(key),
    ]);
    assertCanManageApps(role);
    if (!app || app.ownerWorkspaceId !== actor.workspaceId) throw new AppError("NOT_FOUND");
  }

  /** A write's answer; none means the app went in between. */
  private written(app: AppView | undefined): AppView {
    if (!app) throw new AppError("NOT_FOUND");
    return app;
  }
}
