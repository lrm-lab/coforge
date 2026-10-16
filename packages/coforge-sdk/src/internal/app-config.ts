import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { RPC_METHODS } from "./rpc-methods";
import { isScopeId } from "./scope-id";
import { boundedPayload } from "./codec";
import { isRecord } from "./json-record";
import {
  AppConfigSnapshotRequestSchema,
  AppConfigSyncSchema,
  type AppConfig as WireAppConfig,
} from "#src/internal/gen/coforge/rpc/v1/app_config_pb";

/**
 * Agent App configuration: each Agent App's settings for one owner Agent, kept by the cloud and
 * mirrored to the daemon that runs the Agent. The cloud pushes one App's change (`upsert`) and
 * answers a daemon's snapshot request with every App's settings for that Agent (`snapshot`).
 */
export const APP_CONFIG_SNAPSHOT_METHOD = RPC_METHODS.appConfigSnapshot;
export const APP_CONFIG_SYNC_MESSAGE_TYPE = "coforge.rpc.v1.AppConfigSync" as const;
/** A daemon that advertises this on ready understands `AppConfigSync`; no other is sent one. */
export const APP_CONFIG_CAPABILITY = "app-config:v1" as const;
export const APP_CONFIG_PROTOCOL_MAJOR = 1 as const;

export const CLEANER_APP_ID = "system.cleaner" as const;

/** The System Cleaner's settings: whether it runs, the workspace size that triggers it, and how
 * often it looks. */
export type CleanerAppConfig = { enabled: boolean; thresholdBytes: number; intervalMs: number };

/** One config key's type as an Agent sees it (`coforge app config`): a boolean, or an integer
 * within inclusive bounds. */
export type AppConfigField =
  | { type: "boolean" }
  | { type: "integer"; minimum: number; maximum: number };
/** One config value as an Agent reads and sets it. */
export type AppConfigValue = boolean | number;
export type AppConfigValues = Record<string, AppConfigValue>;

const CLEANER_FIELDS = {
  enabled: { type: "boolean" },
  threshold_bytes: { type: "integer", minimum: 4_096, maximum: 1_073_741_824 },
  interval_seconds: { type: "integer", minimum: 900, maximum: 604_800 },
} as const satisfies Record<string, AppConfigField>;
const CLEANER_DEFAULT_VALUES = { enabled: true, threshold_bytes: 65_536, interval_seconds: 3_600 };
const MS_PER_SECOND = 1_000;

/** Cleaner settings from a complete set of its Agent-facing values. */
const cleanerSettings = (values: AppConfigValues): CleanerAppConfig => ({
  enabled: values.enabled as boolean,
  thresholdBytes: values.threshold_bytes as number,
  intervalMs: (values.interval_seconds as number) * MS_PER_SECOND,
});

export const CLEANER_CONFIG_DEFAULTS: CleanerAppConfig = cleanerSettings(CLEANER_DEFAULT_VALUES);
export const CLEANER_CONFIG_BOUNDS = {
  thresholdBytes: {
    min: CLEANER_FIELDS.threshold_bytes.minimum,
    max: CLEANER_FIELDS.threshold_bytes.maximum,
  },
  intervalMs: {
    min: CLEANER_FIELDS.interval_seconds.minimum * MS_PER_SECOND,
    max: CLEANER_FIELDS.interval_seconds.maximum * MS_PER_SECOND,
  },
} as const;

/** Whether `value` is one `field` accepts: a boolean, or a safe integer within its bounds. */
export const fitsAppConfigField = (field: AppConfigField, value: unknown) =>
  field.type === "boolean"
    ? typeof value === "boolean"
    : typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= field.minimum &&
      value <= field.maximum;

const within = (value: unknown, bounds: { min: number; max: number }) =>
  fitsAppConfigField({ type: "integer", minimum: bounds.min, maximum: bounds.max }, value);

/** Cleaner settings exactly as stored or sent: the three keys, each within its bounds. */
export function validateCleanerAppConfig(value: unknown): CleanerAppConfig {
  if (
    !isRecord(value) ||
    // Three keys, each checked below: no extra or missing one.
    Object.keys(value).length !== 3 ||
    typeof value.enabled !== "boolean" ||
    !within(value.thresholdBytes, CLEANER_CONFIG_BOUNDS.thresholdBytes) ||
    !within(value.intervalMs, CLEANER_CONFIG_BOUNDS.intervalMs)
  )
    throw new Error("invalid cleaner app config");
  return {
    enabled: value.enabled,
    thresholdBytes: value.thresholdBytes as number,
    intervalMs: value.intervalMs as number,
  };
}

/** Every Agent App with configuration, by App ID: its settings type. Add an App here, give it a
 * definition below and a case in `AppConfig.effective` in `app_config.proto`. */
export type AppConfigSettings = { [CLEANER_APP_ID]: CleanerAppConfig };
export type AppConfigAppId = keyof AppConfigSettings;

type AppConfigDefinition<Settings> = {
  /** The App's config keys as an Agent reads and sets them, each with its type and bounds. */
  fields: Record<string, AppConfigField>;
  /** Each key's value while the Agent has not overridden it. */
  defaults: AppConfigValues;
  /** The settings a complete, valid set of values stands for: the one place an Agent-facing key
   * becomes a settings field. */
  settings(values: AppConfigValues): Settings;
  /** Settings as stored or received, or a thrown error naming the App. */
  validate(value: unknown): Settings;
  /** The settings' case in the wire `AppConfig.effective` oneof. */
  wireCase: NonNullable<WireAppConfig["effective"]["case"]>;
};

export const APP_CONFIG_DEFINITIONS: {
  [Id in AppConfigAppId]: AppConfigDefinition<AppConfigSettings[Id]>;
} = {
  [CLEANER_APP_ID]: {
    fields: CLEANER_FIELDS,
    defaults: CLEANER_DEFAULT_VALUES,
    settings: cleanerSettings,
    validate: validateCleanerAppConfig,
    wireCase: "cleaner",
  },
};

export const isAppConfigAppId = (value: string): value is AppConfigAppId =>
  Object.hasOwn(APP_CONFIG_DEFINITIONS, value);

/** One App's effective settings for its owner Agent; `revision` 0 means the App's defaults. */
export type AppConfig = {
  [Id in AppConfigAppId]: {
    appId: Id;
    ownerAgentId: string;
    revision: number;
    effective: AppConfigSettings[Id];
  };
}[AppConfigAppId];

export type AppConfigScope = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  agentId: string;
};
export type AppConfigSync = AppConfigScope & {
  operation: "upsert" | "snapshot";
  configs: AppConfig[];
  messageType: typeof APP_CONFIG_SYNC_MESSAGE_TYPE;
};
export type AppConfigSnapshotRequest = AppConfigScope;

const MAX_BYTES = 65_536;
const bounded = (bytes: Uint8Array) => boundedPayload(bytes, MAX_BYTES, "App config");

function scope<T extends AppConfigScope>(value: T): T {
  if (
    value.protocolMajor !== APP_CONFIG_PROTOCOL_MAJOR ||
    [value.requestId, value.workspaceId, value.computerId, value.agentId].some(
      (id) => !isScopeId(id),
    )
  )
    throw new Error("invalid app config scope");
  return value;
}

function config(value: AppConfig): AppConfig {
  if (!isAppConfigAppId(value.appId) || !isScopeId(value.ownerAgentId))
    throw new Error("invalid app config");
  if (!Number.isSafeInteger(value.revision) || value.revision < 0 || value.revision > 0xffffffff)
    throw new Error("invalid app config revision");
  APP_CONFIG_DEFINITIONS[value.appId].validate(value.effective);
  return value;
}

/** The rules a sync holds to, on both sides; `wireRows` counts rows before unknown Apps are
 * dropped, so an upsert of an App this side does not know is still one row. */
function sync(value: AppConfigSync, wireRows = value.configs.length): AppConfigSync {
  scope(value);
  if (
    value.messageType !== APP_CONFIG_SYNC_MESSAGE_TYPE ||
    !["upsert", "snapshot"].includes(value.operation)
  )
    throw new Error("invalid app config sync");
  if (value.operation === "upsert" && wireRows !== 1)
    throw new Error("app config upsert requires one config");
  value.configs.forEach(config);
  if (value.configs.some((item) => item.ownerAgentId !== value.agentId))
    throw new Error("app config owner does not match sync Agent");
  if (new Set(value.configs.map((item) => item.appId)).size !== value.configs.length)
    throw new Error("duplicate app config for one App");
  return value;
}

export function encodeAppConfigSync(value: AppConfigSync): Uint8Array {
  sync(value);
  return bounded(
    toBinary(
      AppConfigSyncSchema,
      create(AppConfigSyncSchema, {
        ...value,
        configs: value.configs.map((item) => ({
          appId: item.appId,
          ownerAgentId: item.ownerAgentId,
          revision: item.revision,
          effective: {
            case: APP_CONFIG_DEFINITIONS[item.appId].wireCase,
            value: item.effective,
          },
        })),
      }),
    ),
  );
}

/** A sync as received: a row for an App this side does not know is dropped (a newer cloud may
 * configure Apps an older daemon lacks); every other row must be valid, or the sync is refused. */
export function decodeAppConfigSync(bytes: Uint8Array): AppConfigSync {
  const wire = fromBinary(AppConfigSyncSchema, bounded(bytes));
  const configs: AppConfig[] = [];
  for (const row of wire.configs) {
    if (!isAppConfigAppId(row.appId)) continue;
    if (row.effective.case !== APP_CONFIG_DEFINITIONS[row.appId].wireCase)
      throw new Error(`invalid ${row.appId} app config`);
    const { $typeName: _, ...effective } = row.effective.value;
    configs.push({
      appId: row.appId,
      ownerAgentId: row.ownerAgentId,
      revision: row.revision,
      effective,
    });
  }
  return sync(
    {
      protocolMajor: wire.protocolMajor,
      requestId: wire.requestId,
      workspaceId: wire.workspaceId,
      computerId: wire.computerId,
      agentId: wire.agentId,
      operation: wire.operation as AppConfigSync["operation"],
      configs,
      messageType: wire.messageType as typeof APP_CONFIG_SYNC_MESSAGE_TYPE,
    },
    wire.configs.length,
  );
}

export function encodeAppConfigSnapshotRequest(value: AppConfigSnapshotRequest): Uint8Array {
  return bounded(
    toBinary(AppConfigSnapshotRequestSchema, create(AppConfigSnapshotRequestSchema, scope(value))),
  );
}

export function decodeAppConfigSnapshotRequest(bytes: Uint8Array): AppConfigSnapshotRequest {
  const { protocolMajor, requestId, workspaceId, computerId, agentId } = fromBinary(
    AppConfigSnapshotRequestSchema,
    bounded(bytes),
  );
  return scope({ protocolMajor, requestId, workspaceId, computerId, agentId });
}

/** Why `values` is not a valid set of an App's Agent-facing values (a key outside its schema, or
 * a value its field does not accept), or `undefined` when it is. */
export function appConfigValuesProblem(appId: AppConfigAppId, values: unknown): string | undefined {
  if (!isRecord(values)) return "config is not an object";
  const { fields } = APP_CONFIG_DEFINITIONS[appId];
  for (const [key, value] of Object.entries(values)) {
    const field = Object.hasOwn(fields, key) ? fields[key] : undefined;
    if (!field) return `${appId} has no config key ${key}`;
    if (!fitsAppConfigField(field, value))
      return field.type === "boolean"
        ? `${key} must be true or false`
        : `${key} must be an integer from ${field.minimum} to ${field.maximum}`;
  }
  return undefined;
}
