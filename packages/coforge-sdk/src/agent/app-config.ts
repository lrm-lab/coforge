/**
 * Wire contract for `coforge app config`: an Agent reads, and changes at a known revision, the
 * durable config of one of its own Agent Apps (`system.cleaner`, ...). Same `{ ok: false,
 * errorCode, error }` error envelope as the `profile` and `user info` routes.
 */

import type { AppConfigField, AppConfigValues } from "#src/internal/app-config";
import { isRecord } from "#src/internal/json-record";

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

const isValue = (value: unknown) =>
  typeof value === "boolean" || (typeof value === "number" && Number.isSafeInteger(value));

const isValues = (value: unknown): value is AppConfigValues =>
  isRecord(value) && Object.values(value).every(isValue);

const isField = (value: unknown): value is AppConfigField =>
  isRecord(value) &&
  (value.type === "boolean" ||
    (value.type === "integer" &&
      Number.isSafeInteger(value.minimum) &&
      Number.isSafeInteger(value.maximum)));

/** Parses a body the request named its fields in, refusing anything outside the contract. */
export function decodeAgentAppConfigPatch(value: unknown): AgentAppConfigPatch | undefined {
  if (!isRecord(value)) return undefined;
  const { expectedRevision, set = {}, unset = [], idempotencyKey, ...rest } = value;
  if (
    Object.keys(rest).length > 0 ||
    typeof expectedRevision !== "number" ||
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 0 ||
    !isRecord(set) ||
    !Array.isArray(unset) ||
    !unset.every((key) => typeof key === "string" && key.trim().length > 0) ||
    (idempotencyKey !== undefined && typeof idempotencyKey !== "string")
  )
    return undefined;
  return {
    expectedRevision,
    set: set as AppConfigValues,
    unset: (unset as string[]).map((key) => key.trim()),
  };
}

export function decodeAgentAppConfigResponse(value: unknown): AgentAppConfigResponse {
  if (
    !isRecord(value) ||
    value.ok !== true ||
    typeof value.appId !== "string" ||
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    !isRecord(value.schema) ||
    !Object.values(value.schema).every(isField) ||
    !isValues(value.defaults) ||
    !isValues(value.overrides) ||
    !isValues(value.effective)
  )
    throw new Error("invalid Agent app config response");
  return {
    ok: true,
    appId: value.appId,
    revision: value.revision,
    schema: value.schema as Record<string, AppConfigField>,
    defaults: value.defaults,
    overrides: value.overrides,
    effective: value.effective,
  };
}

export function decodeAgentAppConfigErrorResponse(
  value: unknown,
): AgentAppConfigErrorResponse | undefined {
  if (
    !isRecord(value) ||
    value.ok !== false ||
    typeof value.errorCode !== "string" ||
    !(AGENT_APP_CONFIG_ERROR_CODES as readonly string[]).includes(value.errorCode) ||
    typeof value.error !== "string"
  )
    return undefined;
  return {
    ok: false,
    errorCode: value.errorCode as AgentAppConfigErrorCode,
    error: value.error,
  };
}
