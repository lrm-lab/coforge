import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { AppError } from "#src/lib/app-error";
import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { declareNoStore } from "#src/features/no-store-response.server";
import {
  createAppEditorSave,
  createAppPermissions,
} from "#src/server/app-permissions/app-permissions-composition.server";
import type { AppPermissionsView } from "#src/server/app-permissions/app-permissions.server";
import { createAppInstallationSetup } from "#src/server/app-installation-setup/app-installation-setup-composition.server";
import type { AppSetupView } from "#src/server/app-installation-setup/app-installation-setup.server";
import { createAppWebhooks } from "#src/server/app-notifications/app-webhooks-composition.server";
import { createAppPublishing } from "#src/server/app-marketplace/app-publishing-composition.server";
import { createAppRegistry } from "#src/server/apps/app-registry-composition.server";
import { appLogoUrl } from "#src/server/apps/app-logo.server";
import type { AppView } from "#src/server/apps/app-registry.server";
import { actorOf } from "./app-actor";
import { APP_CATEGORIES } from "./app-category";
import type { AppPublishStatus } from "./app-publish-status";
import {
  SETUP_DESCRIPTION_MAX_LENGTH,
  SETUP_URL_MAX_LENGTH,
  type AppSetupSummary,
} from "./app-installation-setup";
import type { WebhookStatus } from "./app-webhook";
import { APP_NOTIFICATION_EVENT_NAMES } from "./app-notification-events";
import { APP_PERMISSION_GROUPS, type AppPermissionsSummary } from "./app-permissions";
import {
  APP_DESCRIPTION_MAX_LENGTH,
  APP_KEY_MAX_LENGTH,
  APP_NAME_MAX_LENGTH,
  APP_SCOPES,
  APP_URL_MAX_LENGTH,
  APP_WHEN_TO_USE_MAX_LENGTH,
  MAX_REDIRECT_URIS,
} from "./app-registration";

/**
 * Settings → Applications. Thin wrappers over the app registry, which decides who may change which
 * app and checks every field (`APP_INPUT_ERROR_IDS`). The schemas here only bound the input's
 * shape and size, so a refused value still reaches the registry and comes back naming its field.
 */

/** An app as the Settings page shows it: its logo as a URL (none shows the monogram), its data
 * permissions only where `app-data-permissions` is on, and its setup only where
 * `app-installation-setup` is on. */
export type AppSummary = Omit<
  AppView,
  | "ownerWorkspaceId"
  | "logoObjectKey"
  | "publishStatus"
  | "secretRotatedAt"
  | "createdAt"
  | "updatedAt"
> & {
  logoUrl: string | null;
  createdAt: string;
  /** This Workspace registered the app (it is its developer); otherwise it installed it from the
   * Marketplace and only uninstalls it. */
  owned: boolean;
  /** The app's signed webhook state; present only for an app this Workspace owns, to an owner or
   * admin, where `app-notifications` is on. */
  webhookStatus?: WebhookStatus;
  permissions?: AppPermissionsSummary;
  setup?: AppSetupSummary;
  /** Where the app is in Marketplace review; present only for an app this Workspace owns, where
   * `app-marketplace` is on: an installing Workspace never sees the developer's review state. */
  publishStatus?: AppPublishStatus;
};

const permissionsSummary = ({
  installationId,
  declared,
  revision,
  effective,
  pending,
  events,
  effectiveEvents,
  pendingEvents,
}: AppPermissionsView): AppPermissionsSummary => ({
  installationId,
  declared,
  revision,
  effective,
  pending,
  events,
  effectiveEvents,
  pendingEvents,
});

const setupSummary = ({
  installationId,
  status,
  url,
  description,
  link,
  completedAt,
}: AppSetupView): AppSetupSummary => ({
  url,
  description,
  installation: { installationId, status, link, completedAt: completedAt?.toISOString() ?? null },
});

const summary = (
  {
    ownerWorkspaceId,
    logoObjectKey,
    publishStatus,
    secretRotatedAt: _rotated,
    updatedAt: _updated,
    createdAt,
    ...app
  }: AppView,
  /** The Workspace asking, to say whether the app is its own. */
  viewerWorkspaceId: string,
  permissions?: AppPermissionsView | null,
  setup?: AppSetupView | null,
  /** `app-marketplace` is on: the summary says where the app is in review. */
  marketplace = false,
): AppSummary => ({
  ...app,
  logoUrl: appLogoUrl(ownerWorkspaceId, app.key, logoObjectKey),
  owned: ownerWorkspaceId === viewerWorkspaceId,
  createdAt: createdAt.toISOString(),
  ...(permissions && { permissions: permissionsSummary(permissions) }),
  ...(setup && { setup: setupSummary(setup) }),
  // The developer's review state is the developer's: an installing Workspace never sees it.
  ...(marketplace && ownerWorkspaceId === viewerWorkspaceId && { publishStatus }),
});

/** A text the registry counts in code points; zod counts UTF-16 units, at most two per code point. */
const text = (maxCodePoints: number) => z.string().max(maxCodePoints * 2);
const url = z.string().max(APP_URL_MAX_LENGTH);

const fields = {
  name: text(APP_NAME_MAX_LENGTH),
  description: text(APP_DESCRIPTION_MAX_LENGTH),
  whenToUse: text(APP_WHEN_TO_USE_MAX_LENGTH),
  homepageUrl: url.nullable(),
  agentManifestUrl: url.nullable().optional(),
  redirectUris: z.array(url).max(MAX_REDIRECT_URIS),
  // Chosen from a list, so a value outside it is a malformed request, not a field to correct.
  category: z.enum(APP_CATEGORIES),
  allowedScopes: z.array(z.string()).max(APP_SCOPES.length),
};

const keyInput = z.object({ key: z.string().max(APP_KEY_MAX_LENGTH) });

/** Which declarations the editor shows in this Workspace: where the `app-data-permissions` and
 * `app-installation-setup` flags are on, and, with `app-data-permissions`, `app-notifications`
 * (the App notifications section and the events in the permissions); `manifest` where
 * `app-agent-manifest` is on, `marketplace` and `reviewer` where `app-marketplace` is. */
export type AppDeclarations = {
  permissions: boolean;
  setup: boolean;
  notifications: boolean;
  /** The Agent manifest URL field and rows (`app-agent-manifest`). */
  manifest: boolean;
  /** `app-marketplace` is on: the editor's Distribution section and the apps' publish status. */
  marketplace: boolean;
  /** The viewer reviews Marketplace requests (a platform operator), where it is on. */
  reviewer: boolean;
};

/** The apps installed in the Workspace (the ones it registered), and the declarations it shows. */
export const loadWorkspaceApps = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context }) => {
    declareNoStore();
    const actor = actorOf(context);
    const [{ apps, manifest, workspaceSlug }, permissions, setups] = await Promise.all([
      createAppRegistry(context.db).listWorkspaceApps(actor),
      createAppPermissions(context.db).workspacePermissions(actor),
      createAppInstallationSetup(context.db).workspaceSetups(actor),
    ]);
    // After the member check above, which read the slug.
    const { enabled: marketplace, reviewer } = await createAppPublishing(context.db).access(
      { workspaceId: actor.workspaceId, workspaceSlug },
      actor.actorUserId,
    );
    const notifications = permissions?.notifications ?? false;
    const webhookStatuses = notifications
      ? await createAppWebhooks(context.db).workspaceStatuses(actor)
      : null;
    return {
      apps: apps.map((app) => ({
        ...summary(
          app,
          actor.workspaceId,
          permissions?.apps.get(app.key),
          setups?.get(app.key),
          marketplace,
        ),
        ...(webhookStatuses &&
          app.ownerWorkspaceId === actor.workspaceId && {
            webhookStatus: webhookStatuses.get(app.key) ?? "off",
          }),
      })),
      declares: {
        permissions: permissions !== null,
        setup: setups !== null,
        notifications,
        manifest,
        marketplace,
        reviewer,
      } satisfies AppDeclarations,
    };
  });

/** The data groups, notification events and setup page an app declares, where the editor shows
 * them. The events are declared with the groups and need them. */
const declarations = {
  permissionGroups: z.array(z.string()).max(APP_PERMISSION_GROUPS.length).optional(),
  notificationEvents: z.array(z.string()).max(APP_NOTIFICATION_EVENT_NAMES.length).optional(),
  setup: z
    .object({
      url: z.string().max(SETUP_URL_MAX_LENGTH).nullable(),
      description: text(SETUP_DESCRIPTION_MAX_LENGTH),
    })
    .optional(),
};

/** Registers an app in the Workspace; a blank key asks for one made from its name. With
 * `permissionGroups` it declares the data it reads (refused where `app-data-permissions` is off;
 * the Workspace's installation starts with them pending approval) and, with `setup`, the page it is
 * set up on (refused where `app-installation-setup` is off): one change with the registration
 * (`AppEditorSave`). The answer carries its client secret, once. */
export const registerWorkspaceApp = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(keyInput.extend(fields).extend(declarations))
  .handler(async ({ data, context }) => {
    declareNoStore();
    const { permissionGroups, notificationEvents, setup, ...input } = data;
    const {
      app,
      clientSecret,
      permissions,
      setup: declaredSetup,
    } = await createAppEditorSave(context.db).register(actorOf(context), input, {
      permissionGroups,
      notificationEvents,
      setup,
    });
    return {
      app: summary(app, context.workspaceId, permissions, declaredSetup),
      clientSecret,
    };
  });

/** Changes any field of the Workspace's app but its key and, with `permissionGroups`, the data it
 * declares (refused where `app-data-permissions` is off) and, with `setup`, the page it is set up
 * on (refused where `app-installation-setup` is off). One change: a refusal of any leaves the app
 * as it was (`AppEditorSave`). */
export const updateWorkspaceApp = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    keyInput.extend({
      patch: z.object(fields).partial(),
      ...declarations,
    }),
  )
  .handler(async ({ data, context }) => {
    declareNoStore();
    const actor = actorOf(context);
    const { app, permissions, setup, workspaceSlug } = await createAppEditorSave(context.db).save(
      actor,
      data.key,
      {
        patch: data.patch,
        permissionGroups: data.permissionGroups,
        notificationEvents: data.notificationEvents,
        setup: data.setup,
      },
    );
    const marketplace = await createAppPublishing(context.db).isEnabledIn({
      workspaceId: actor.workspaceId,
      workspaceSlug,
    });
    return summary(app, actor.workspaceId, permissions, setup, marketplace);
  });

/** Approves the data app `key` declares at `revision`, the one the approver was shown, for this
 * Workspace's installation; CONFLICT (`app-permissions-changed`) once the app declared again. */
export const approveWorkspaceAppPermissions = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(keyInput.extend({ revision: z.number().int().nonnegative() }))
  .handler(async ({ data, context }) => {
    declareNoStore();
    return permissionsSummary(
      await createAppPermissions(context.db).approve(actorOf(context), data.key, data.revision),
    );
  });

/** Replaces the app's client secret; the answer is the new one, once. */
export const rotateWorkspaceAppSecret = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(keyInput)
  .handler(async ({ data, context }) => {
    declareNoStore();
    const { clientSecret } = await createAppRegistry(context.db).rotateAppSecret(
      actorOf(context),
      data.key,
    );
    return { clientSecret };
  });

const logoFile = z.custom<File>((value) => typeof File !== "undefined" && value instanceof File);

/** Replaces the app's logo, at once, with the `file` of a FormData that also names its `key`. The
 * registry checks the image (`APP_LOGO_UPLOAD_TYPES`, at most 5 MB, bytes sniffed). */
export const uploadWorkspaceAppLogo = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator((data: unknown) => {
    if (!(data instanceof FormData)) throw new AppError("INVALID_INPUT");
    const key = keyInput.shape.key.safeParse(data.get("key"));
    const file = logoFile.safeParse(data.get("file"));
    if (!key.success || !file.success) throw new AppError("INVALID_INPUT");
    return { key: key.data, file: file.data };
  })
  .handler(async ({ data, context }) => {
    declareNoStore();
    return summary(
      await createAppRegistry(context.db).setAppLogo(actorOf(context), data.key, data.file),
      context.workspaceId,
    );
  });

/** Puts the app back on its monogram; its uploaded logo is removed. */
export const resetWorkspaceAppLogo = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(keyInput)
  .handler(async ({ data, context }) => {
    declareNoStore();
    return summary(
      await createAppRegistry(context.db).resetAppLogo(actorOf(context), data.key),
      context.workspaceId,
    );
  });

/** Deletes the Workspace's app. */
export const deleteWorkspaceApp = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(keyInput)
  .handler(async ({ data, context }) => {
    declareNoStore();
    await createAppRegistry(context.db).deleteApp(actorOf(context), data.key);
  });
