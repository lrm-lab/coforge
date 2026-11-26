/**
 * Wire contract for an Agent managing an app beyond registering it (`coforge app update|logo|
 * clear-logo|transfer-owner|delete|share-link|share-link-status|revoke-share-link|
 * request-publish|request-unpublish`). The requests are operations of the one local route
 * (`app-registration.ts`), and the cloud has one route for each. Same `{ ok: false, errorCode,
 * error }` envelope as `app token`. The owner-recovery card is `app:recover_owner`
 * (`app-recover-owner-card.ts`).
 */
import { z } from "zod";

/** The longest an Agent-given share link lives is a year; the shortest a day (Raft's range). */
export const APP_SHARE_LINK_MIN_DAYS = 1;
export const APP_SHARE_LINK_MAX_DAYS = 365;
/** A logo is at most 5 MB (the web app's limit); its base64 text and the rest of the request fit
 * in `APP_REGISTRATION_REQUEST_MAX_BYTES`, which the daemon's local route accepts. */
export const APP_LOGO_MAX_BYTES = 5 * 1024 * 1024;
export const APP_REGISTRATION_REQUEST_MAX_BYTES = 8 * 1024 * 1024;

/** The registered fields `app update` may change; absent ones stay. A null URL clears it. The
 * redirect URLs are replaced by `redirectUrls` or extended by `addRedirectUrls`, never both, and
 * never emptied. `scopes` replace the Login scopes beyond the fixed ones; `[]` clears them. */
export type AppUpdateChanges = {
  name?: string;
  description?: string;
  whenToUse?: string;
  category?: string;
  homepageUrl?: string | null;
  redirectUrls?: string[];
  addRedirectUrls?: string[];
  agentManifestUrl?: string | null;
  scopes?: string[];
};

export type AgentAppManagementRequest =
  | { operation: "rotate_secret"; clientKey: string }
  | { operation: "update"; clientKey: string; changes: AppUpdateChanges }
  | { operation: "logo_set"; clientKey: string; contentType: string; dataBase64: string }
  | { operation: "logo_clear"; clientKey: string }
  | { operation: "transfer_owner"; clientKey: string; toAgent: string }
  | { operation: "delete"; clientKey: string }
  | { operation: "share_link_create"; clientKey: string; expiresDays: number }
  | { operation: "share_link_status"; clientKey: string }
  | { operation: "share_link_revoke"; clientKey: string }
  | { operation: "request_publish"; clientKey: string }
  | { operation: "request_unpublish"; clientKey: string };

const filledStringSchema = z.string().min(1);
const textListSchema = z.array(z.string());
const urlOrNullSchema = z.string().nullable();

const appUpdateChangesSchema = z
  .strictObject({
    name: z.string().exactOptional(),
    description: z.string().exactOptional(),
    whenToUse: z.string().exactOptional(),
    category: z.string().exactOptional(),
    homepageUrl: urlOrNullSchema.exactOptional(),
    redirectUrls: textListSchema.exactOptional(),
    addRedirectUrls: textListSchema.exactOptional(),
    agentManifestUrl: urlOrNullSchema.exactOptional(),
    scopes: textListSchema.exactOptional(),
  })
  .refine(
    (changes) =>
      Object.values(changes).some((entry) => entry !== undefined) &&
      !(changes.redirectUrls !== undefined && changes.addRedirectUrls !== undefined),
  );

const SIMPLE_MANAGEMENT_OPERATIONS = [
  "rotate_secret",
  "logo_clear",
  "delete",
  "share_link_status",
  "share_link_revoke",
  "request_publish",
  "request_unpublish",
] as const;

const appManagementRequestSchema = z.union([
  z.strictObject({
    operation: z.literal("update"),
    clientKey: z.string(),
    changes: appUpdateChangesSchema,
  }),
  z.strictObject({
    operation: z.literal("logo_set"),
    clientKey: z.string(),
    contentType: filledStringSchema,
    dataBase64: filledStringSchema,
  }),
  z.strictObject({
    operation: z.literal("transfer_owner"),
    clientKey: z.string(),
    toAgent: z.string().min(1).max(120),
  }),
  z.strictObject({
    operation: z.literal("share_link_create"),
    clientKey: z.string(),
    expiresDays: z.int().min(APP_SHARE_LINK_MIN_DAYS).max(APP_SHARE_LINK_MAX_DAYS),
  }),
  z.strictObject({
    operation: z.enum(SIMPLE_MANAGEMENT_OPERATIONS),
    clientKey: z.string(),
  }),
]);

export function decodeAgentAppManagementRequest(
  value: unknown,
  isId: (field: unknown) => field is string,
): AgentAppManagementRequest | undefined {
  const parsed = appManagementRequestSchema.safeParse(value);
  if (!parsed.success || !isId(parsed.data.clientKey)) return undefined;
  return parsed.data;
}

/** An app as `app update` and the logo commands answer it. */
export type AppManagedSummary = {
  clientKey: string;
  name: string;
  description: string;
  whenToUse: string;
  category: string;
  homepageUrl: string | null;
  redirectUrls: string[];
  agentManifestUrl: string | null;
  /** Every Login scope the app may ask for, the fixed ones included. */
  scopes: string[];
  hasLogo: boolean;
  publishStatus: string;
};
export type AppManagedResponse = { ok: true; app: AppManagedSummary };

/** `changed: false`: the app already had that owner Agent, so nothing happened. */
export type AppOwnerTransferResponse = {
  ok: true;
  clientKey: string;
  changed: boolean;
  ownerAgent: string;
  previousOwnerAgent: string | null;
  at: string;
};
export type AppDeletedResponse = { ok: true; clientKey: string; deleted: true };
/** The link's URL is in this answer and nowhere else. */
export type AppShareLinkCreatedResponse = {
  ok: true;
  clientKey: string;
  url: string;
  createdAt: string;
  expiresAt: string;
};
export type AppShareLinkStatusResponse = {
  ok: true;
  clientKey: string;
  active: boolean;
  createdAt?: string;
  expiresAt?: string;
};
export type AppShareLinkRevokedResponse = { ok: true; clientKey: string; revoked: true };
export type AppPublishRequestResponse = { ok: true; clientKey: string; publishStatus: string };

function decodeResponse<T>(value: unknown, schema: z.ZodType<T>, what: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(`invalid ${what} response`);
  return parsed.data;
}

const appManagedSummarySchema = z.looseObject({
  clientKey: filledStringSchema,
  name: z.string(),
  description: z.string(),
  whenToUse: z.string(),
  category: z.string(),
  homepageUrl: urlOrNullSchema,
  redirectUrls: textListSchema,
  agentManifestUrl: urlOrNullSchema,
  scopes: textListSchema,
  hasLogo: z.boolean(),
  publishStatus: z.string(),
});

const appManagedResponseSchema = z.looseObject({
  ok: z.literal(true),
  app: appManagedSummarySchema,
});

const appOwnerTransferResponseSchema = z.looseObject({
  ok: z.literal(true),
  clientKey: filledStringSchema,
  changed: z.boolean(),
  ownerAgent: z.string(),
  previousOwnerAgent: urlOrNullSchema,
  at: z.string(),
});

const appDeletedResponseSchema = z.looseObject({
  ok: z.literal(true),
  clientKey: filledStringSchema,
  deleted: z.literal(true),
});

const appShareLinkCreatedResponseSchema = z.looseObject({
  ok: z.literal(true),
  clientKey: filledStringSchema,
  url: filledStringSchema,
  createdAt: z.string(),
  expiresAt: z.string(),
});

const appShareLinkStatusResponseSchema = z.looseObject({
  ok: z.literal(true),
  clientKey: filledStringSchema,
  active: z.boolean(),
  createdAt: z.string().optional(),
  expiresAt: z.string().optional(),
});

const appShareLinkRevokedResponseSchema = z.looseObject({
  ok: z.literal(true),
  clientKey: filledStringSchema,
  revoked: z.literal(true),
});

const appPublishRequestResponseSchema = z.looseObject({
  ok: z.literal(true),
  clientKey: filledStringSchema,
  publishStatus: filledStringSchema,
});

export const decodeAppManagedResponse = (value: unknown): AppManagedResponse =>
  decodeResponse(value, appManagedResponseSchema, "app");

export const decodeAppOwnerTransferResponse = (value: unknown): AppOwnerTransferResponse =>
  decodeResponse(value, appOwnerTransferResponseSchema, "owner transfer");

export const decodeAppDeletedResponse = (value: unknown): AppDeletedResponse =>
  decodeResponse(value, appDeletedResponseSchema, "app deletion");

export const decodeAppShareLinkCreatedResponse = (value: unknown): AppShareLinkCreatedResponse =>
  decodeResponse(value, appShareLinkCreatedResponseSchema, "share link");

export const decodeAppShareLinkStatusResponse = (value: unknown): AppShareLinkStatusResponse =>
  decodeResponse(value, appShareLinkStatusResponseSchema, "share link status");

export const decodeAppShareLinkRevokedResponse = (value: unknown): AppShareLinkRevokedResponse =>
  decodeResponse(value, appShareLinkRevokedResponseSchema, "share link revocation");

export const decodeAppPublishRequestResponse = (value: unknown): AppPublishRequestResponse =>
  decodeResponse(value, appPublishRequestResponseSchema, "publish request");
