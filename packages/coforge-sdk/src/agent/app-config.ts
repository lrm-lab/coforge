/**
 * Wire contract for `coforge app config`: an Agent reads, and changes at a known revision, the
 * durable config of one of its own Agent Apps (`system.cleaner`, ...). Same `{ ok: false,
 * errorCode, error }` error envelope as the `profile` and `user info` routes.
 */

import { z } from "zod";
import type { AppConfigField, AppConfigValues } from "#src/internal/app-config";

/** One App's config as its owner Agent sees it. `overrides` holds exactly the keys the Agent set
 * (a value equal to the default is still an override); `effective` is `defaults` with
 * `overrides` applied. Revision 0 means nothing has been set yet. */
export type AgentAppConfigView = {
  appId: string;
  revision: number;
  schema: Record<string, AppConfigField>;
  defaults: AppConfigValues;
  overrides: AppConfigValues;
  effective: AppConfigValues;
};

/** Response for `GET` and `PATCH /api/agent/v1/apps/:appId/config`. */
export type AgentAppConfigResponse = { ok: true } & AgentAppConfigView;

/** A change to one App's config, applied whole or not at all. `expectedRevision` is the revision
 * the change was made against: any other current revision refuses it (`revision_conflict`), so a
 * repeated request never applies twice. `unset` returns a key to its default. */
export type AgentAppConfigPatch = {
  expectedRevision: number;
  set: AppConfigValues;
  unset: string[];
};

/** Request for `PATCH /api/agent/v1/apps/:appId/config`. `idempotencyKey` names one CLI
 * invocation and is kept the same if the request is sent again. */
export type AgentAppConfigUpdateRequest = AgentAppConfigPatch & {
  appId: string;
  idempotencyKey: string;
};

export type AgentAppConfigGetRequest = { appId: string };

/** `app_not_found`: the Agent has no App with that id. `config_invalid`: a key outside the App's
 * schema, a value of the wrong type or out of bounds, or a key both set and unset.
 * `revision_conflict`: the config changed since `expectedRevision`; read it again and retry. */
export const AGENT_APP_CONFIG_ERROR_CODES = [
  "app_not_found",
  "config_invalid",
  "revision_conflict",
] as const;
export type AgentAppConfigErrorCode = (typeof AGENT_APP_CONFIG_ERROR_CODES)[number];

export type AgentAppConfigErrorResponse = {
  ok: false;
  errorCode: AgentAppConfigErrorCode;
  error: string;
};

const appConfigValueSchema = z.union([z.boolean(), z.int()]);
const appConfigValuesSchema = z.record(z.string(), appConfigValueSchema);

const appConfigFieldSchema = z.discriminatedUnion("type", [
  z.looseObject({ type: z.literal("boolean") }),
  z.looseObject({
    type: z.literal("integer"),
    minimum: z.int(),
    maximum: z.int(),
  }),
]);

const appConfigPatchSchema = z.strictObject({
  expectedRevision: z.int().min(0),
  set: z.record(z.string(), z.unknown()).default({}),
  unset: z
    .array(
      z
        .string()
        .refine((key) => key.trim().length > 0)
        .transform((key) => key.trim()),
    )
    .default([]),
  idempotencyKey: z.string().optional(),
});

const appConfigResponseSchema = z.object({
  ok: z.literal(true),
  appId: z.string(),
  revision: z.int().min(0),
  schema: z.record(z.string(), appConfigFieldSchema),
  defaults: appConfigValuesSchema,
  overrides: appConfigValuesSchema,
  effective: appConfigValuesSchema,
});

const appConfigErrorResponseSchema = z.object({
  ok: z.literal(false),
  errorCode: z.enum(AGENT_APP_CONFIG_ERROR_CODES),
  error: z.string(),
});

export function decodeAgentAppConfigPatch(value: unknown): AgentAppConfigPatch | undefined {
  const parsed = appConfigPatchSchema.safeParse(value);
  if (!parsed.success) return undefined;
  return {
    expectedRevision: parsed.data.expectedRevision,
    set: parsed.data.set as AppConfigValues,
    unset: parsed.data.unset,
  };
}

export function decodeAgentAppConfigResponse(value: unknown): AgentAppConfigResponse {
  const parsed = appConfigResponseSchema.safeParse(value);
  if (!parsed.success) throw new Error("invalid Agent app config response");
  return parsed.data;
}

export function decodeAgentAppConfigErrorResponse(
  value: unknown,
): AgentAppConfigErrorResponse | undefined {
  const parsed = appConfigErrorResponseSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
