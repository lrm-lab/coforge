/**
 * Wire contract for `coforge app list` and `coforge app token`: an Agent lists the apps its
 * Workspace installed (and the built-in Agent Apps), and gets a short-lived token to call one.
 * Same `{ ok: false, errorCode, error }` error envelope as `app config`.
 */

import { APP_IDENTITY_SCOPES as APP_SCOPES } from "#src/internal/app-scopes";
import { isRecord } from "#src/internal/json-record";
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

const isText = (value: unknown): value is string => typeof value === "string";
const isFilled = (value: unknown): value is string => isText(value) && value.length > 0;

function decodeApp(value: unknown): AgentAppView {
  if (
    !isRecord(value) ||
    !isFilled(value.key) ||
    !isText(value.name) ||
    !isText(value.description) ||
    !isText(value.whenToUse) ||
    !(value.homepageUrl === null || isText(value.homepageUrl)) ||
    typeof value.builtIn !== "boolean" ||
    !(
      value.access === undefined ||
      (AGENT_APP_ACCESS_STATES as readonly unknown[]).includes(value.access)
    ) ||
    !(
      value.agentManifestUrl === undefined ||
      value.agentManifestUrl === null ||
      isText(value.agentManifestUrl)
    ) ||
    !(
      value.agentManifestUrlSource === undefined ||
      value.agentManifestUrlSource === null ||
      (AGENT_MANIFEST_URL_SOURCES as readonly unknown[]).includes(value.agentManifestUrlSource)
    )
  )
    throw new Error("invalid Agent app list response");
  const app: AgentAppView = {
    key: value.key,
    name: value.name,
    description: value.description,
    whenToUse: value.whenToUse,
    homepageUrl: value.homepageUrl,
    builtIn: value.builtIn,
  };
  if (value.access !== undefined) app.access = value.access as AgentAppAccessState;
  if (value.agentManifestUrl !== undefined) {
    app.agentManifestUrl = value.agentManifestUrl as string | null;
    app.agentManifestUrlSource = (value.agentManifestUrlSource ??
      null) as AgentManifestUrlSource | null;
  }
  return app;
}

export function decodeAgentAppListResponse(value: unknown): AgentAppListResponse {
  if (!isRecord(value) || value.ok !== true || !Array.isArray(value.apps))
    throw new Error("invalid Agent app list response");
  return { ok: true, apps: value.apps.map(decodeApp) };
}

export function decodeAgentAppTokenResponse(value: unknown): AgentAppTokenResponse {
  if (isRecord(value) && value.ok === true) {
    if (
      value.status === "issued" &&
      isFilled(value.access_token) &&
      value.token_type === "Bearer" &&
      typeof value.expires_in === "number" &&
      isFilled(value.audience) &&
      isText(value.scope)
    )
      return {
        ok: true,
        status: "issued",
        access_token: value.access_token,
        token_type: "Bearer",
        expires_in: value.expires_in,
        audience: value.audience,
        scope: value.scope,
      };
    if (
      value.status === "approval_required" &&
      isFilled(value.requestId) &&
      (value.actionCardMessageId === undefined || isFilled(value.actionCardMessageId))
    )
      return {
        ok: true,
        status: "approval_required",
        requestId: value.requestId,
        ...(value.actionCardMessageId ? { actionCardMessageId: value.actionCardMessageId } : {}),
        ...(Array.isArray(value.scopes) && value.scopes.every(isFilled)
          ? { scopes: value.scopes as string[] }
          : {}),
      };
    if (value.status === "not_installed") return { ok: true, status: "not_installed" };
  }
  throw new Error("invalid Agent app token response");
}

/** The token request body, refusing anything outside the contract. */
export function decodeAgentAppTokenBody(value: unknown): AgentAppTokenBody | undefined {
  if (!isRecord(value)) return undefined;
  const { target, scopes, ...rest } = value;
  if (
    Object.keys(rest).length > 0 ||
    !(target === undefined || (isFilled(target) && target.length <= 200))
  )
    return undefined;
  if (
    scopes !== undefined &&
    !(
      Array.isArray(scopes) &&
      scopes.length <= APP_SCOPES.length &&
      new Set(scopes).size === scopes.length &&
      scopes.every((scope) => (APP_SCOPES as readonly unknown[]).includes(scope))
    )
  )
    return undefined;
  return {
    ...(target === undefined ? {} : { target }),
    ...(scopes === undefined ? {} : { scopes: scopes as string[] }),
  };
}

export function decodeAgentAppErrorResponse(value: unknown): AgentAppErrorResponse | undefined {
  if (
    !isRecord(value) ||
    value.ok !== false ||
    !(AGENT_APP_ERROR_CODES as readonly unknown[]).includes(value.errorCode) ||
    !isText(value.error)
  )
    return undefined;
  return { ok: false, errorCode: value.errorCode as AgentAppErrorCode, error: value.error };
}
