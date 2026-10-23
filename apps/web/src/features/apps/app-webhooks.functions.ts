import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import {
  workspaceUserMiddleware,
  type WorkspaceUserContext,
} from "#src/features/auth/function-auth";
import { declareNoStore } from "#src/features/no-store-response.server";
import { createAppWebhooks } from "#src/server/app-notifications/app-webhooks-composition.server";
import type { InstallationWebhookStatus } from "#src/server/app-notifications/app-webhook-store";
import type {
  AppWebhookChange,
  AppWebhookView,
} from "#src/server/app-notifications/app-webhooks.server";
import type { AppActor } from "#src/server/apps/app-registry.server";
import { APP_KEY_MAX_LENGTH } from "./app-registration";
import {
  WEBHOOK_ENDPOINT_MAX_LENGTH,
  type WebhookDisabledReason,
  type WebhookStatus,
} from "./app-webhook";

/**
 * An app's signed webhook, for the editor's Webhook section (next slice). Thin wrappers over
 * `AppWebhooks`, which checks that the member is an owner or admin of the app's Workspace, the
 * `app-notifications` flag and the endpoint. The schemas here only bound the input's shape and
 * size, so a refused endpoint still reaches the module and comes back naming its `errorId`.
 */

/** How deliveries to one installation are going; times are ISO 8601. */
export type WebhookStatusSummary = {
  /** Whether deliveries to the installation continue: false once they stopped. */
  enabled: boolean;
  /** When they stopped; null while `enabled`. */
  disabledAt: string | null;
  lastAttemptAt: string | null;
  lastDeliveryAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  nextAttemptAt: string | null;
  disabledReason: WebhookDisabledReason | null;
};

export type AppWebhookSummary = {
  /** Off, Setup (switched on, no endpoint yet) or Enabled (delivering). */
  status: WebhookStatus;
  enabled: boolean;
  endpointUrl: string | null;
  revision: number;
  secretGeneration: number;
  previousSecretValidUntil: string | null;
  installations: {
    installationId: string;
    workspaceId: string;
    status: WebhookStatusSummary | null;
  }[];
};

/** The webhook and, when this call made a secret, the signing secret (Raft's `signing_secret`):
 * shown once, never read back. */
export type AppWebhookChangeSummary = { webhook: AppWebhookSummary; signingSecret?: string };

const iso = (date: Date | null) => date?.toISOString() ?? null;

const statusSummary = (status: InstallationWebhookStatus): WebhookStatusSummary => ({
  enabled: status.disabledReason === null,
  disabledAt: iso(status.disabledAt),
  lastAttemptAt: iso(status.lastAttemptAt),
  lastDeliveryAt: iso(status.lastDeliveryAt),
  lastError: status.lastError,
  consecutiveFailures: status.consecutiveFailures,
  nextAttemptAt: iso(status.nextAttemptAt),
  disabledReason: status.disabledReason,
});

const summary = (view: AppWebhookView): AppWebhookSummary => ({
  status: view.status,
  enabled: view.enabled,
  endpointUrl: view.endpointUrl,
  revision: view.revision,
  secretGeneration: view.secretGeneration,
  previousSecretValidUntil: iso(view.previousSecretValidUntil),
  installations: view.installations.map(({ installationId, workspaceId, status }) => ({
    installationId,
    workspaceId,
    status: status && statusSummary(status),
  })),
});

const changeSummary = ({ webhook, signingSecret }: AppWebhookChange): AppWebhookChangeSummary => ({
  webhook: summary(webhook),
  ...(signingSecret !== undefined && { signingSecret }),
});

const keyInput = z.object({ key: z.string().max(APP_KEY_MAX_LENGTH) });

/** The member acting, in the Workspace the page URL names. */
const actorOf = ({ user, workspaceId }: WorkspaceUserContext): AppActor => ({
  workspaceId,
  actorUserId: user.id,
});

/** The app's webhook and the delivery status of each installation; `null` while `app-notifications`
 * is off for the Workspace. */
export const loadAppWebhook = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(keyInput)
  .handler(async ({ data, context }) => {
    declareNoStore();
    const view = await createAppWebhooks(context.db).read(actorOf(context), data.key);
    return view && summary(view);
  });

/** Switches the webhook on without an endpoint (Setup); nothing is delivered until one is saved.
 * Switching on an enabled one changes nothing. */
export const enableAppWebhook = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(keyInput)
  .handler(async ({ data, context }) => {
    declareNoStore();
    return changeSummary(await createAppWebhooks(context.db).enable(actorOf(context), data.key));
  });

/** Enables the webhook at the endpoint, or moves an enabled one there (every installation's
 * status starts over). The answer carries the signing secret, once, only when the webhook had no endpoint before. */
export const saveAppWebhookEndpoint = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(keyInput.extend({ endpointUrl: z.string().max(WEBHOOK_ENDPOINT_MAX_LENGTH) }))
  .handler(async ({ data, context }) => {
    declareNoStore();
    return changeSummary(
      await createAppWebhooks(context.db).save(actorOf(context), data.key, data.endpointUrl),
    );
  });

/** Replaces the signing secret; the old one keeps signing for 24 hours. The answer is the new
 * secret, once. */
export const rotateAppWebhookSecret = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(keyInput)
  .handler(async ({ data, context }) => {
    declareNoStore();
    return changeSummary(await createAppWebhooks(context.db).rotate(actorOf(context), data.key));
  });

/** Turns the webhook off and deletes its endpoint at once. */
export const disableAppWebhook = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(keyInput)
  .handler(async ({ data, context }) => {
    declareNoStore();
    return changeSummary(await createAppWebhooks(context.db).disable(actorOf(context), data.key));
  });
