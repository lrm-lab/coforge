/**
 * Wire contract for an Agent managing an app beyond registering it (`coforge app update|logo|
 * clear-logo|transfer-owner|delete|share-link|share-link-status|revoke-share-link|
 * request-publish|request-unpublish`). The requests are operations of the one local route
 * (`app-registration.ts`), and the cloud has one route for each. Same `{ ok: false, errorCode,
 * error }` envelope as `app token`. The owner-recovery card is `app:recover_owner`
 * (`app-recover-owner-card.ts`).
 */
import { isRecord } from "#src/internal/json-record";

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

const isText = (value: unknown): value is string => typeof value === "string";
const isFilled = (value: unknown): value is string => isText(value) && value.length > 0;
const isTextList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(isText);
const isUrlOrNull = (value: unknown) => value === null || isText(value);

/** Each field `app update` takes, with the shape it must have. */
const CHANGE_SHAPES: Record<keyof AppUpdateChanges, (value: unknown) => boolean> = {
  name: isText,
  description: isText,
  whenToUse: isText,
  category: isText,
  homepageUrl: isUrlOrNull,
  redirectUrls: isTextList,
  addRedirectUrls: isTextList,
  agentManifestUrl: isUrlOrNull,
  scopes: isTextList,
};

function decodeChanges(value: unknown): AppUpdateChanges | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > Object.keys(CHANGE_SHAPES).length) return undefined;
  for (const [field, entry] of entries)
    if (
      !Object.hasOwn(CHANGE_SHAPES, field) ||
      !CHANGE_SHAPES[field as keyof AppUpdateChanges](entry)
    )
      return undefined;
  if (value.redirectUrls !== undefined && value.addRedirectUrls !== undefined) return undefined;
  return value as AppUpdateChanges;
}

/** Exactly the fields the operation takes, or `undefined` for anything else (including an
 * operation of the registration vocabulary, which `decodeAgentAppRegistrationRequest` takes). */
export function decodeAgentAppManagementRequest(
  value: unknown,
  isId: (field: unknown) => field is string,
): AgentAppManagementRequest | undefined {
  if (!isRecord(value) || !isId(value.clientKey)) return undefined;
  const { operation, clientKey, ...rest } = value;
  const keys = Object.keys(rest);
  const only = (...allowed: string[]) =>
    keys.length === allowed.length && allowed.every((key) => keys.includes(key));
  switch (operation) {
    case "update": {
      const changes = decodeChanges(rest.changes);
      return only("changes") && changes ? { operation, clientKey, changes } : undefined;
    }
    case "logo_set":
      return only("contentType", "dataBase64") &&
        isFilled(rest.contentType) &&
        isFilled(rest.dataBase64)
        ? { operation, clientKey, contentType: rest.contentType, dataBase64: rest.dataBase64 }
        : undefined;
    case "transfer_owner":
      return only("toAgent") && isFilled(rest.toAgent) && rest.toAgent.length <= 120
        ? { operation, clientKey, toAgent: rest.toAgent }
        : undefined;
    case "share_link_create":
      return only("expiresDays") &&
        Number.isInteger(rest.expiresDays) &&
        (rest.expiresDays as number) >= APP_SHARE_LINK_MIN_DAYS &&
        (rest.expiresDays as number) <= APP_SHARE_LINK_MAX_DAYS
        ? { operation, clientKey, expiresDays: rest.expiresDays as number }
        : undefined;
    case "rotate_secret":
    case "logo_clear":
    case "delete":
    case "share_link_status":
    case "share_link_revoke":
    case "request_publish":
    case "request_unpublish":
      return keys.length === 0 ? { operation, clientKey } : undefined;
    default:
      return undefined;
  }
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

type Shape = Record<string, (value: unknown) => boolean>;
const text = isText;
const optionalText = (value: unknown) => value === undefined || isText(value);
const flag = (value: unknown) => typeof value === "boolean";

function decodeShape<T>(value: unknown, shape: Shape, what: string): T {
  if (!isRecord(value) || value.ok !== true) throw new Error(`invalid ${what} response`);
  for (const [field, valid] of Object.entries(shape))
    if (!valid(value[field])) throw new Error(`invalid ${what} response`);
  return value as T;
}

export const decodeAppManagedResponse = (value: unknown): AppManagedResponse => {
  const decoded = decodeShape<AppManagedResponse>(value, { app: isRecord }, "app");
  decodeShape<AppManagedSummary>(
    { ok: true, ...decoded.app },
    {
      clientKey: isFilled,
      name: text,
      description: text,
      whenToUse: text,
      category: text,
      homepageUrl: isUrlOrNull,
      redirectUrls: isTextList,
      agentManifestUrl: isUrlOrNull,
      scopes: isTextList,
      hasLogo: flag,
      publishStatus: text,
    },
    "app",
  );
  return decoded;
};

export const decodeAppOwnerTransferResponse = (value: unknown) =>
  decodeShape<AppOwnerTransferResponse>(
    value,
    {
      clientKey: isFilled,
      changed: flag,
      ownerAgent: text,
      previousOwnerAgent: isUrlOrNull,
      at: text,
    },
    "owner transfer",
  );

export const decodeAppDeletedResponse = (value: unknown) =>
  decodeShape<AppDeletedResponse>(
    value,
    { clientKey: isFilled, deleted: (field) => field === true },
    "app deletion",
  );

export const decodeAppShareLinkCreatedResponse = (value: unknown) =>
  decodeShape<AppShareLinkCreatedResponse>(
    value,
    { clientKey: isFilled, url: isFilled, createdAt: text, expiresAt: text },
    "share link",
  );

export const decodeAppShareLinkStatusResponse = (value: unknown) =>
  decodeShape<AppShareLinkStatusResponse>(
    value,
    { clientKey: isFilled, active: flag, createdAt: optionalText, expiresAt: optionalText },
    "share link status",
  );

export const decodeAppShareLinkRevokedResponse = (value: unknown) =>
  decodeShape<AppShareLinkRevokedResponse>(
    value,
    { clientKey: isFilled, revoked: (field) => field === true },
    "share link revocation",
  );

export const decodeAppPublishRequestResponse = (value: unknown) =>
  decodeShape<AppPublishRequestResponse>(
    value,
    { clientKey: isFilled, publishStatus: isFilled },
    "publish request",
  );
