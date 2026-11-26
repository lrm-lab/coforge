/**
 * Wire contract for `coforge app marketplace`: an Agent browses, with its own identity, the apps
 * other Workspaces published, as any member of its Workspace sees them (task #477; Raft's
 * `integration marketplace`). Read only: installing stays a person's. Errors use the
 * `{ ok: false, errorCode, error }` envelope of the other app routes.
 */

import { z } from "zod";

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

const marketplaceAppSchema = z.object({
  key: z.string(),
  name: z.string(),
  description: z.string(),
  category: z.string(),
  developer: z.string(),
  homepageUrl: z.string().nullable(),
  homepageHost: z.string().nullable(),
  callbackDomains: z.array(z.string()),
  allowedScopes: z.array(z.string()),
  permissionGroups: z.array(z.string()),
  notificationEvents: z.array(z.string()),
  logoUrl: z.string().nullable(),
  installCount: z.number(),
  publishedAt: z.string().nullable(),
  installed: z.boolean(),
});

const appMarketplaceResponseSchema = z.object({
  surface: z.literal("public_marketplace"),
  metadataTrust: z.literal("untrusted_app_supplied"),
  query: z.string().nullable(),
  limit: z.number(),
  truncated: z.boolean(),
  apps: z.array(marketplaceAppSchema),
});

export function decodeAgentAppMarketplaceResponse(value: unknown): AgentAppMarketplaceResponse {
  const parsed = appMarketplaceResponseSchema.safeParse(value);
  if (!parsed.success) throw new Error("invalid Agent app marketplace response");
  return parsed.data;
}
