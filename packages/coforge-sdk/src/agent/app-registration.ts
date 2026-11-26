/**
 * Wire contract for an Agent managing the apps it registered (`coforge app status`,
 * `coforge app list --owned`, `coforge app rotate-secret`). The card itself is prepared through
 * `POST /api/agent/v1/actions/prepare` with an `app:register` action. Same
 * `{ ok: false, errorCode, error }` error envelope as `app token`.
 */
import { z } from "zod";
import { decodeAgentAppManagementRequest, type AgentAppManagementRequest } from "./app-management";

/** The longest card id or client key a status or rotation names. */
export const APP_REGISTRATION_ID_MAX_LENGTH = 64;

const filledStringSchema = z.string().min(1);
const registrationIdSchema = z.string().min(1).max(APP_REGISTRATION_ID_MAX_LENGTH);

const registrationRequestSchema = z.union([
  z.strictObject({ operation: z.literal("owned_list") }),
  z.strictObject({ operation: z.literal("register_status"), card: registrationIdSchema }),
  z.strictObject({ operation: z.literal("register_status"), client: registrationIdSchema }),
]);

/** One request as the daemon's local proxy hands it on to the cloud. */
export type AgentAppRegistrationRequest =
  | { operation: "register_status"; card?: string; client?: string }
  | { operation: "owned_list" }
  | AgentAppManagementRequest;

export function decodeAgentAppRegistrationRequest(
  value: unknown,
): AgentAppRegistrationRequest | undefined {
  const parsed = registrationRequestSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  return decodeAgentAppManagementRequest(
    value,
    (field): field is string => registrationIdSchema.safeParse(field).success,
  );
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

const appRegistrationStatusResponseSchema = z.object({
  ok: z.literal(true),
  status: z.enum(APP_REGISTRATION_STATES),
  cardMessageId: filledStringSchema.optional(),
  clientKey: filledStringSchema.optional(),
  committedBy: filledStringSchema.optional(),
});

const appOwnedListResponseSchema = z.object({
  ok: z.literal(true),
  pending: z.array(
    z.object({
      cardMessageId: filledStringSchema,
      name: z.string(),
      clientKey: filledStringSchema.nullable(),
    }),
  ),
  apps: z.array(
    z.object({
      clientKey: filledStringSchema,
      name: z.string(),
      role: z.enum(["owner", "admin"]),
    }),
  ),
});

const appSecretRotationResponseSchema = z.object({
  ok: z.literal(true),
  clientKey: filledStringSchema,
  clientSecret: filledStringSchema,
});

export function decodeAppRegistrationStatusResponse(value: unknown): AppRegistrationStatusResponse {
  const parsed = appRegistrationStatusResponseSchema.safeParse(value);
  if (!parsed.success) throw new Error("invalid app registration status response");
  const { ok, status, cardMessageId, clientKey, committedBy } = parsed.data;
  return {
    ok,
    status,
    ...(cardMessageId !== undefined ? { cardMessageId } : {}),
    ...(clientKey !== undefined ? { clientKey } : {}),
    ...(committedBy !== undefined ? { committedBy } : {}),
  };
}

export function decodeAppOwnedListResponse(value: unknown): AppOwnedListResponse {
  const parsed = appOwnedListResponseSchema.safeParse(value);
  if (!parsed.success) throw new Error("invalid owned app list response");
  return parsed.data;
}

export function decodeAppSecretRotationResponse(value: unknown): AppSecretRotationResponse {
  const parsed = appSecretRotationResponseSchema.safeParse(value);
  if (!parsed.success) throw new Error("invalid app secret rotation response");
  return parsed.data;
}
