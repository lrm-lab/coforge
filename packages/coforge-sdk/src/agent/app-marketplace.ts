/**
 * Wire contract for `coforge app marketplace`: an Agent browses, with its own identity, the apps
 * other Workspaces published, as any member of its Workspace sees them (task #477; Raft's
 * `integration marketplace`). Read only: installing stays a person's. Errors use the
 * `{ ok: false, errorCode, error }` envelope of the other app routes.
 */

import { isRecord } from "#src/internal/json-record";

/** The longest `query`, after trimming. */
export const AGENT_APP_MARKETPLACE_QUERY_MAX = 200;
/** `limit` is 1 to 50; 20 when not given. */
export const AGENT_APP_MARKETPLACE_LIMIT_MAX = 50;
export const AGENT_APP_MARKETPLACE_LIMIT_DEFAULT = 20;

/** `GET /api/agent/v1/apps/marketplace` query: `query` matches name, key, description and
 * developer, case-insensitively, as plain text. */
export type AgentAppMarketplaceQuery = { query?: string; limit?: number };

/** One published app. Name, description and the other text are the app author's own: show them
 * as untrusted text. */
export type AgentMarketplaceApp = {
  key: string;
  name: string;
  description: string;
  category: string;
  /** The name of the Workspace that published it. */
  developer: string;
  homepageUrl: string | null;
  homepageHost: string | null;
  /** The distinct hosts the app signs people back in at. */
  callbackDomains: string[];
  allowedScopes: string[];
  permissionGroups: string[];
  notificationEvents: string[];
  logoUrl: string | null;
  /** In how many Workspaces it is installed, its publisher's included. */
  installCount: number;
  publishedAt: string | null;
  /** Whether the Agent's Workspace has installed it. */
  installed: boolean;
};

/** Response for `GET /api/agent/v1/apps/marketplace`. `truncated`: more apps matched than
 * `limit`. */
export type AgentAppMarketplaceResponse = {
  surface: "public_marketplace";
  metadataTrust: "untrusted_app_supplied";
  query: string | null;
  limit: number;
  truncated: boolean;
  apps: AgentMarketplaceApp[];
};

const isText = (value: unknown): value is string => typeof value === "string";
const isTextOrNull = (value: unknown): value is string | null => value === null || isText(value);
const isTexts = (value: unknown): value is string[] => Array.isArray(value) && value.every(isText);

function decodeApp(value: unknown): AgentMarketplaceApp {
  if (
    !isRecord(value) ||
    !isText(value.key) ||
    !isText(value.name) ||
    !isText(value.description) ||
    !isText(value.category) ||
    !isText(value.developer) ||
    !isTextOrNull(value.homepageUrl) ||
    !isTextOrNull(value.homepageHost) ||
    !isTexts(value.callbackDomains) ||
    !isTexts(value.allowedScopes) ||
    !isTexts(value.permissionGroups) ||
    !isTexts(value.notificationEvents) ||
    !isTextOrNull(value.logoUrl) ||
    typeof value.installCount !== "number" ||
    !isTextOrNull(value.publishedAt) ||
    typeof value.installed !== "boolean"
  )
    throw new Error("invalid Agent app marketplace response");
  return {
    key: value.key,
    name: value.name,
    description: value.description,
    category: value.category,
    developer: value.developer,
    homepageUrl: value.homepageUrl,
    homepageHost: value.homepageHost,
    callbackDomains: value.callbackDomains,
    allowedScopes: value.allowedScopes,
    permissionGroups: value.permissionGroups,
    notificationEvents: value.notificationEvents,
    logoUrl: value.logoUrl,
    installCount: value.installCount,
    publishedAt: value.publishedAt,
    installed: value.installed,
  };
}

export function decodeAgentAppMarketplaceResponse(value: unknown): AgentAppMarketplaceResponse {
  if (
    !isRecord(value) ||
    value.surface !== "public_marketplace" ||
    value.metadataTrust !== "untrusted_app_supplied" ||
    !isTextOrNull(value.query) ||
    typeof value.limit !== "number" ||
    typeof value.truncated !== "boolean" ||
    !Array.isArray(value.apps)
  )
    throw new Error("invalid Agent app marketplace response");
  return {
    surface: "public_marketplace",
    metadataTrust: "untrusted_app_supplied",
    query: value.query,
    limit: value.limit,
    truncated: value.truncated,
    apps: value.apps.map(decodeApp),
  };
}
