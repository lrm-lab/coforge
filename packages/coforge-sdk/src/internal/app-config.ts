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

export const CLEANER_CONFIG_DEFAULTS: CleanerAppConfig = {
  enabled: true,
  thresholdBytes: 65_536,
  intervalMs: 3_600_000,
};
export const CLEANER_CONFIG_BOUNDS = {
  thresholdBytes: { min: 4_096, max: 1_073_741_824 },
  intervalMs: { min: 900_000, max: 604_800_000 },
} as const;

const within = (value: unknown, bounds: { min: number; max: number }) =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= bounds.min &&
  value <= bounds.max;

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
  /** What an Agent with no stored row has. */
  defaults: Settings;
  /** Settings as stored or received, or a thrown error naming the App. */
  validate(value: unknown): Settings;
  /** The settings' case in the wire `AppConfig.effective` oneof. */
  wireCase: NonNullable<WireAppConfig["effective"]["case"]>;
};

export const APP_CONFIG_DEFINITIONS: {
  [Id in AppConfigAppId]: AppConfigDefinition<AppConfigSettings[Id]>;
} = {
  [CLEANER_APP_ID]: {
    defaults: CLEANER_CONFIG_DEFAULTS,
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
