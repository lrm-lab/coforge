/**
 * Wire contract for `coforge app list`, `coforge app token` and `coforge app marketplace`: an
 * Agent lists the apps its Workspace installed (and the built-in Agent Apps), gets a short-lived
 * token to call one, and browses the Marketplace. Same `{ ok: false, errorCode, error }` error
 * envelope as `app config`.
 */

import { z } from "zod";
import { APP_IDENTITY_SCOPES as APP_SCOPES } from "#src/internal/app-scopes";
import type { AgentAppMarketplaceQuery } from "./app-marketplace";
import type { AgentAppRegistrationRequest } from "./app-registration";

/** The Agent's access to an installed app: it has a grant (`granted`), its first use grants one
 * (`automatic`), a person must approve it (`needs_approval`), or its request waits for a person
 * (`pending_approval`). */
export const AGENT_APP_ACCESS_STATES = [
  "granted",
  "automatic",
  "needs_approval",
  "pending_approval",
] as const;
export type AgentAppAccessState = (typeof AGENT_APP_ACCESS_STATES)[number];

/** One app as the Agent sees it. A built-in Agent App has no `access`: it is the Agent's own and
 * needs no token. */
export type AgentAppView = {
  key: string;
  name: string;
  description: string;
  whenToUse: string;
  homepageUrl: string | null;
  builtIn: boolean;
  access?: AgentAppAccessState;
  /** Where the app's Agent manifest is (a public JSON document the publisher wrote, to be read as
   * data), and whether the publisher gave it (`explicit`) or it is the well-known path on the
   * homepage's origin (`well_known`). Both present or both absent; absent where the server does not
   * list manifests, and `null` for an app that names none and has no homepage. */
  agentManifestUrl?: string | null;
  agentManifestUrlSource?: AgentManifestUrlSource | null;
};

export const AGENT_MANIFEST_URL_SOURCES = ["explicit", "well_known"] as const;
export type AgentManifestUrlSource = (typeof AGENT_MANIFEST_URL_SOURCES)[number];

/** Response for `GET /api/agent/v1/apps`. */
export type AgentAppListResponse = { ok: true; apps: AgentAppView[] };

/** `POST /api/agent/v1/apps/:key/token` body. `target` is where an approval card is posted when
 * a person must approve the Agent's use of the app. It carries no idempotency key: asking again is
 * harmless by construction, since an Agent has at most one waiting request per app, at most one
 * card per request, and one grant per app, and each token is a fresh five-minute one. */
export type AgentAppTokenBody = {
  target?: string;
  /** The Login with CoForge scopes the token is for (an action's `required_scopes`): unique, each
   * one of `APP_SCOPES`. The token's `scope` is exactly these plus the fixed identity scopes, and
   * a scope the Agent's grant lacks waits for a person's approval. Absent: the grant's scopes (an
   * older CLI sends none). A server that predates the field ignores it, and a running daemon that
   * predates it refuses the request as `request_invalid`: the CLI checks the issued `scope` covers
   * what it asked for, and never retries without `scopes`. */
  scopes?: string[];
};
export type AgentAppTokenRequest = AgentAppTokenBody & { appKey: string };
/** One app request as the daemon's local proxy hands it on to the cloud. */
export type AgentAppRequest =
  | { operation: "list" }
  | ({ operation: "token" } & AgentAppTokenRequest)
  | ({ operation: "marketplace" } & AgentAppMarketplaceQuery)
  | AgentAppRegistrationRequest;

/** A token for the app: an RFC 9068 JWT whose audience is the app's client ID, for five minutes. */
export type AgentAppTokenIssued = {
  ok: true;
  status: "issued";
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  audience: string;
  scope: string;
};

/** The Agent's use waits for a person's approval of request `requestId`; `actionCardMessageId` is
 * the approval card, once one was posted. */
export type AgentAppApprovalRequired = {
  ok: true;
  status: "approval_required";
  requestId: string;
  actionCardMessageId?: string;
  /** The scopes the waiting request asks a person to grant (absent from an older server). */
  scopes?: string[];
};

export type AgentAppTokenResponse =
  | AgentAppTokenIssued
  | AgentAppApprovalRequired
  | { ok: true; status: "not_installed" };

/** `app_tokens_unavailable`: this server runs no authorization server (Login with CoForge).
 * `request_invalid`: the body is not `{ target?, scopes? }`. `target_invalid`: the approval card
 * cannot be posted to the target given. `not_found`, `conflict`, `invalid_input` and `access_denied` are the
 * server's own refusals of the use (the Agent is gone, or a concurrent use won a race, say). */
export const AGENT_APP_ERROR_CODES = [
  "app_tokens_unavailable",
  "request_invalid",
  "target_invalid",
  "not_found",
  "conflict",
  "invalid_input",
  "access_denied",
] as const;
export type AgentAppErrorCode = (typeof AGENT_APP_ERROR_CODES)[number];
export type AgentAppErrorResponse = { ok: false; errorCode: AgentAppErrorCode; error: string };

const filledStringSchema = z.string().min(1);

const agentAppViewSchema = z
  .object({
    key: filledStringSchema,
    name: z.string(),
    description: z.string(),
    whenToUse: z.string(),
    homepageUrl: z.string().nullable(),
    builtIn: z.boolean(),
    access: z.enum(AGENT_APP_ACCESS_STATES).optional(),
    agentManifestUrl: z.string().nullable().optional(),
    agentManifestUrlSource: z.enum(AGENT_MANIFEST_URL_SOURCES).nullable().optional(),
  })
  .transform((value): AgentAppView => {
    const app: AgentAppView = {
      key: value.key,
      name: value.name,
      description: value.description,
      whenToUse: value.whenToUse,
      homepageUrl: value.homepageUrl,
      builtIn: value.builtIn,
    };
    if (value.access !== undefined) app.access = value.access;
    if (value.agentManifestUrl !== undefined) {
      app.agentManifestUrl = value.agentManifestUrl;
      app.agentManifestUrlSource = value.agentManifestUrlSource ?? null;
    }
    return app;
  });

const agentAppListResponseSchema = z.object({
  ok: z.literal(true),
  apps: z.array(agentAppViewSchema),
});

const agentAppTokenResponseSchema = z.discriminatedUnion("status", [
  z.object({
    ok: z.literal(true),
    status: z.literal("issued"),
    access_token: filledStringSchema,
    token_type: z.literal("Bearer"),
    expires_in: z.number(),
    audience: filledStringSchema,
    scope: z.string(),
  }),
  z
    .object({
      ok: z.literal(true),
      status: z.literal("approval_required"),
      requestId: filledStringSchema,
      actionCardMessageId: filledStringSchema.optional(),
      scopes: z.array(filledStringSchema).optional().catch(undefined),
    })
    .transform((value): AgentAppApprovalRequired => ({
      ok: true,
      status: "approval_required",
      requestId: value.requestId,
      ...(value.actionCardMessageId ? { actionCardMessageId: value.actionCardMessageId } : {}),
      ...(value.scopes !== undefined ? { scopes: value.scopes } : {}),
    })),
  z.object({
    ok: z.literal(true),
    status: z.literal("not_installed"),
  }),
]);

const agentAppTokenBodySchema = z.strictObject({
  target: z.string().min(1).max(200).optional(),
  scopes: z
    .array(z.enum(APP_SCOPES))
    .max(APP_SCOPES.length)
    .refine((scopes) => new Set(scopes).size === scopes.length)
    .optional(),
});

const agentAppErrorResponseSchema = z.object({
  ok: z.literal(false),
  errorCode: z.enum(AGENT_APP_ERROR_CODES),
  error: z.string(),
});

export function decodeAgentAppListResponse(value: unknown): AgentAppListResponse {
  const parsed = agentAppListResponseSchema.safeParse(value);
  if (!parsed.success) throw new Error("invalid Agent app list response");
  return parsed.data;
}

export function decodeAgentAppTokenResponse(value: unknown): AgentAppTokenResponse {
  const parsed = agentAppTokenResponseSchema.safeParse(value);
  if (!parsed.success) throw new Error("invalid Agent app token response");
  return parsed.data;
}

export function decodeAgentAppTokenBody(value: unknown): AgentAppTokenBody | undefined {
  const parsed = agentAppTokenBodySchema.safeParse(value);
  if (!parsed.success) return undefined;
  const { target, scopes } = parsed.data;
  return {
    ...(target === undefined ? {} : { target }),
    ...(scopes === undefined ? {} : { scopes }),
  };
}

export function decodeAgentAppErrorResponse(value: unknown): AgentAppErrorResponse | undefined {
  const parsed = agentAppErrorResponseSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
