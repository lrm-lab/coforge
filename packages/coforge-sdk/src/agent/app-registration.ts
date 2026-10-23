/**
 * Wire contract for an Agent managing the apps it registered (`coforge app status`,
 * `coforge app list --owned`, `coforge app rotate-secret`). The card itself is prepared through
 * `POST /api/agent/v1/actions/prepare` with an `app:register` action. Same
 * `{ ok: false, errorCode, error }` error envelope as `app token`.
 */
import { isRecord } from "#src/internal/json-record";

const isText = (value: unknown): value is string => typeof value === "string";
const isFilled = (value: unknown): value is string => isText(value) && value.length > 0;

/** The longest card id or client key a status or rotation names. */
export const APP_REGISTRATION_ID_MAX_LENGTH = 64;

/** One request as the daemon's local proxy hands it on to the cloud. */
export type AgentAppRegistrationRequest =
  | { operation: "register_status"; card?: string; client?: string }
  | { operation: "owned_list" }
  | { operation: "rotate_secret"; clientKey: string };

/** Exactly the fields the operation takes, or `undefined` for anything else. `register_status`
 * names a card (`card`) or an app (`client`), never both. The operation names are the request's
 * own, from the CLI through the daemon to this decoder. */
export function decodeAgentAppRegistrationRequest(
  value: unknown,
): AgentAppRegistrationRequest | undefined {
  if (!isRecord(value)) return undefined;
  const { operation, ...rest } = value;
  const keys = Object.keys(rest);
  const only = (...allowed: string[]) => keys.every((key) => allowed.includes(key));
  const id = (field: unknown): field is string =>
    isFilled(field) && field.length <= APP_REGISTRATION_ID_MAX_LENGTH;
  if (operation === "owned_list") return keys.length === 0 ? { operation } : undefined;
  if (operation === "rotate_secret")
    return id(rest.clientKey) && only("clientKey")
      ? { operation, clientKey: rest.clientKey }
      : undefined;
  if (operation !== "register_status" || !only("card", "client")) return undefined;
  const { card, client } = rest;
  if (id(card) && client === undefined) return { operation, card };
  if (id(client) && card === undefined) return { operation, client };
  return undefined;
}

/** `card_pending`: the card waits for an owner or admin. `committed`: the app exists. `cancelled`:
 * the card was dismissed. */
export const APP_REGISTRATION_STATES = ["card_pending", "committed", "cancelled"] as const;
export type AppRegistrationState = (typeof APP_REGISTRATION_STATES)[number];

export type AppRegistrationStatusResponse = {
  ok: true;
  status: AppRegistrationState;
  cardMessageId?: string;
  clientKey?: string;
  committedBy?: string;
};

export type AppOwnedListResponse = {
  ok: true;
  /** The Agent's register cards still waiting; `clientKey` is null while it is to be made. */
  pending: { cardMessageId: string; name: string; clientKey: string | null }[];
  /** `owner`: the Agent registered it. `admin`: an admin Agent sees every app of its Workspace. */
  apps: { clientKey: string; name: string; role: "owner" | "admin" }[];
};

/** The new secret, in this answer and nowhere else. */
export type AppSecretRotationResponse = { ok: true; clientKey: string; clientSecret: string };

export function decodeAppRegistrationStatusResponse(value: unknown): AppRegistrationStatusResponse {
  if (
    !isRecord(value) ||
    value.ok !== true ||
    !(APP_REGISTRATION_STATES as readonly unknown[]).includes(value.status)
  )
    throw new Error("invalid app registration status response");
  const out: AppRegistrationStatusResponse = {
    ok: true,
    status: value.status as AppRegistrationState,
  };
  for (const field of ["cardMessageId", "clientKey", "committedBy"] as const) {
    if (value[field] === undefined) continue;
    if (!isFilled(value[field])) throw new Error("invalid app registration status response");
    out[field] = value[field];
  }
  return out;
}

export function decodeAppOwnedListResponse(value: unknown): AppOwnedListResponse {
  if (
    !isRecord(value) ||
    value.ok !== true ||
    !Array.isArray(value.pending) ||
    !Array.isArray(value.apps)
  )
    throw new Error("invalid owned app list response");
  const pending = value.pending.map((row: unknown) => {
    if (
      !isRecord(row) ||
      !isFilled(row.cardMessageId) ||
      !isText(row.name) ||
      !(row.clientKey === null || isFilled(row.clientKey))
    )
      throw new Error("invalid owned app list response");
    return { cardMessageId: row.cardMessageId, name: row.name, clientKey: row.clientKey };
  });
  const apps = value.apps.map((row: unknown): AppOwnedListResponse["apps"][number] => {
    if (
      !isRecord(row) ||
      !isFilled(row.clientKey) ||
      !isText(row.name) ||
      (row.role !== "owner" && row.role !== "admin")
    )
      throw new Error("invalid owned app list response");
    return { clientKey: row.clientKey, name: row.name, role: row.role };
  });
  return { ok: true, pending, apps };
}

export function decodeAppSecretRotationResponse(value: unknown): AppSecretRotationResponse {
  if (
    !isRecord(value) ||
    value.ok !== true ||
    !isFilled(value.clientKey) ||
    !isFilled(value.clientSecret)
  )
    throw new Error("invalid app secret rotation response");
  return { ok: true, clientKey: value.clientKey, clientSecret: value.clientSecret };
}
