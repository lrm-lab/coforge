import { APP_FIXED_SCOPES } from "@lrm/coforge-sdk/internal/app-scopes";
import {
  APP_LOGO_MAX_BYTES,
  type AppManagedSummary,
  type AppUpdateChanges,
} from "@lrm/coforge-sdk/agent";
import type { AppCategory } from "#src/features/apps/app-category";
import type { AppPatch } from "#src/features/apps/app-registration";
import { AppError } from "#src/lib/app-error";
import type { AppPublishing } from "#src/server/app-marketplace/app-publishing.server";
import type { AppShareLinks } from "#src/server/app-marketplace/app-share-links.server";
import type { AppOwnerAgents, OwnerAgentCaller } from "./app-owner-agents.server";
import type { AppRegistry, AppView } from "./app-registry.server";

/** The app as `app update` and the logo commands answer it: never its secret or its hash. */
export function managedSummary(app: AppView): AppManagedSummary {
  return {
    clientKey: app.key,
    name: app.name,
    description: app.description,
    whenToUse: app.whenToUse,
    category: app.category,
    homepageUrl: app.homepageUrl,
    redirectUrls: app.redirectUris,
    agentManifestUrl: app.agentManifestUrl,
    scopes: app.allowedScopes,
    hasLogo: app.logoObjectKey !== null,
    publishStatus: app.publishStatus,
  };
}

/**
 * An Agent managing an app beyond registering it, as Raft's `integration app` commands do: change
 * its fields and logo without a person's approval, hand it to another Agent, rotate its secret,
 * delete it while unpublished, make and revoke its private share link, and ask for its publication
 * or removal. `AppOwnerAgents.manager` is the one authorization (the owner Agent, or an admin-role
 * Agent of the app's Workspace, alive; anything else is NOT_FOUND) and hands back the app it read;
 * the work is the registry's, `AppShareLinks`' and `AppPublishing`' own `...Managed...`
 * operations, so their rules apply unchanged. Installed Workspaces re-approve data-permission
 * changes through the installation's own mechanism, which an update here never touches.
 */
export class AppAgentManagement {
  constructor(
    private readonly owners: AppOwnerAgents,
    private readonly registry: AppRegistry,
    private readonly shareLinks: AppShareLinks,
    private readonly publishing: AppPublishing,
  ) {}

  rotateSecret(caller: OwnerAgentCaller, clientKey: string) {
    return this.owners.rotateSecret(caller, clientKey);
  }

  transferOwner(caller: OwnerAgentCaller, clientKey: string, toAgent: string) {
    return this.owners.transferOwner(caller, clientKey, toAgent);
  }

  /** Changes the fields `changes` names. A redirect URL is never cleared (Raft refuses it): the
   * list is replaced by a non-empty one, or extended. */
  async update(caller: OwnerAgentCaller, clientKey: string, changes: AppUpdateChanges) {
    const managed = await this.owners.manager(caller, clientKey);
    const patch: AppPatch = {};
    if (changes.name !== undefined) patch.name = changes.name;
    if (changes.description !== undefined) patch.description = changes.description;
    if (changes.whenToUse !== undefined) patch.whenToUse = changes.whenToUse;
    if (changes.category !== undefined) patch.category = changes.category as AppCategory;
    if (changes.homepageUrl !== undefined) patch.homepageUrl = changes.homepageUrl;
    if (changes.agentManifestUrl !== undefined) patch.agentManifestUrl = changes.agentManifestUrl;
    const redirects =
      changes.redirectUrls ??
      (changes.addRedirectUrls && [...managed.app.redirectUris, ...changes.addRedirectUrls]);
    if (redirects) {
      if (redirects.length === 0)
        throw new AppError("INVALID_INPUT", { errorId: "app-redirect-uris-invalid" });
      patch.redirectUris = [...new Set(redirects)];
    }
    if (changes.scopes)
      patch.allowedScopes = [...new Set([...APP_FIXED_SCOPES, ...changes.scopes])];
    return managedSummary(await this.registry.updateManagedApp(managed, patch));
  }

  /** `logo` is a PNG, JPEG, GIF or WebP of at most 5 MB, checked by the registry's own rule. */
  async setLogo(
    caller: OwnerAgentCaller,
    clientKey: string,
    logo: { contentType: string; dataBase64: string },
  ) {
    const managed = await this.owners.manager(caller, clientKey);
    // Base64 is 4 characters for 3 bytes: refuse an oversize text before decoding it.
    if (logo.dataBase64.length > Math.ceil(APP_LOGO_MAX_BYTES / 3) * 4)
      throw new AppError("INVALID_INPUT");
    const file = new File([Buffer.from(logo.dataBase64, "base64")], "logo", {
      type: logo.contentType,
    });
    return managedSummary(await this.registry.setManagedLogo(managed, file));
  }

  async clearLogo(caller: OwnerAgentCaller, clientKey: string) {
    const managed = await this.owners.manager(caller, clientKey);
    return managedSummary(await this.registry.resetManagedLogo(managed));
  }

  /** Deletes an app that is not published or waiting to leave the Marketplace. */
  async delete(caller: OwnerAgentCaller, clientKey: string) {
    await this.registry.deleteManagedApp(await this.owners.manager(caller, clientKey));
    return { clientKey, deleted: true as const };
  }

  /** The link's URL is in this answer and nowhere else; the previous link stops working. */
  async createShareLink(
    caller: OwnerAgentCaller,
    clientKey: string,
    options: { expiresDays: number; origin: string },
  ) {
    const link = await this.shareLinks.createManaged(await this.owners.manager(caller, clientKey), {
      expiresInDays: options.expiresDays,
    });
    return {
      clientKey,
      url: `${options.origin}/apps/share/${link.token}`,
      createdAt: link.createdAt.toISOString(),
      expiresAt: link.expiresAt.toISOString(),
    };
  }

  /** When the active link ends; never its URL. */
  async shareLinkStatus(caller: OwnerAgentCaller, clientKey: string) {
    const status = await this.shareLinks.statusManaged(
      await this.owners.manager(caller, clientKey),
    );
    return status
      ? {
          clientKey,
          active: true,
          createdAt: status.createdAt.toISOString(),
          expiresAt: status.expiresAt.toISOString(),
        }
      : { clientKey, active: false };
  }

  async revokeShareLink(caller: OwnerAgentCaller, clientKey: string) {
    await this.shareLinks.revokeManaged(await this.owners.manager(caller, clientKey));
    return { clientKey, revoked: true as const };
  }

  /** Files a publish request (the app needs a description) and answers the status it reached. */
  async requestPublish(caller: OwnerAgentCaller, clientKey: string) {
    const managed = await this.owners.manager(caller, clientKey);
    return { clientKey, publishStatus: await this.publishing.requestPublishManaged(managed) };
  }

  async requestUnpublish(caller: OwnerAgentCaller, clientKey: string) {
    const managed = await this.owners.manager(caller, clientKey);
    return { clientKey, publishStatus: await this.publishing.requestUnpublishManaged(managed) };
  }
}
