import {
  APP_CONFIG_DEFINITIONS,
  APP_CONFIG_PROTOCOL_MAJOR,
  APP_CONFIG_SYNC_MESSAGE_TYPE,
  appConfigValuesProblem,
  encodeAppConfigSync,
  isAppConfigAppId,
  type AppConfig,
  type AppConfigAppId,
  type AppConfigSnapshotRequest,
  type AppConfigSync,
  type AppConfigValues,
} from "@lrm/coforge-sdk/internal";
import type { AgentAppConfigPatch, AgentAppConfigView } from "@lrm/coforge-sdk/agent";
import { errorType } from "#src/server/errors/error-type.server";

/** One stored row: the keys of an App's config an Agent overrode, by its Agent-facing key, as
 * written. Never deleted to reset an App: the daemon fences on `revision`, so a reset is a write
 * of `{}` at the next one. */
export type StoredAgentAppConfig = { appId: string; revision: number; config: unknown };

export interface AgentAppConfigRepository {
  /** Where a live (not deleted) Agent runs, or `undefined` for no such Agent. */
  placement(
    agentId: string,
  ): Promise<{ workspaceId: string; computerId: string | null } | undefined>;
  list(agentId: string): Promise<StoredAgentAppConfig[]>;
  get(agentId: string, appId: string): Promise<StoredAgentAppConfig | undefined>;
  /** Stores `config` at `expectedRevision + 1` if the App's stored revision (0 with no row) is
   * still `expectedRevision`; whether it was written. */
  write(
    agentId: string,
    appId: string,
    expectedRevision: number,
    config: AppConfigValues,
  ): Promise<boolean>;
}

export type AppConfigReadOutcome =
  | { state: "found"; config: AgentAppConfigView }
  | { state: "app_not_found" };
export type AppConfigUpdateOutcome =
  | { state: "updated"; config: AgentAppConfigView }
  | { state: "app_not_found" }
  | { state: "revision_conflict"; revision: number }
  | { state: "config_invalid"; reason: string };

export interface AppConfigCapabilityLease {
  supports(workspaceId: string, computerId: string): Promise<boolean>;
}

export type AppConfigPublisher = (sync: AppConfigSync) => Promise<void>;

const APP_IDS = Object.keys(APP_CONFIG_DEFINITIONS) as AppConfigAppId[];

type ReadRow = { revision: number; overrides: AppConfigValues };

/** A stored row's overrides, or none when they no longer validate: an App then runs on its
 * defaults at the row's revision rather than failing every read of the Agent's config. */
function readRow(agentId: string, appId: AppConfigAppId, row: StoredAgentAppConfig | undefined) {
  if (!row) return { revision: 0, overrides: {} };
  const reason = appConfigValuesProblem(appId, row.config);
  if (reason === undefined)
    return { revision: row.revision, overrides: row.config as AppConfigValues };
  console.warn(
    JSON.stringify({
      event: "agent_app_config:stored_config_invalid",
      agent_id: agentId,
      app_id: appId,
      revision: row.revision,
      reason,
    }),
  );
  return { revision: row.revision, overrides: {} };
}

function view(appId: AppConfigAppId, { revision, overrides }: ReadRow): AgentAppConfigView {
  const { fields, defaults } = APP_CONFIG_DEFINITIONS[appId];
  return {
    appId,
    revision,
    schema: fields,
    defaults,
    overrides,
    effective: { ...defaults, ...overrides },
  };
}

function effectiveConfig(agentId: string, appId: AppConfigAppId, row: ReadRow): AppConfig {
  const definition = APP_CONFIG_DEFINITIONS[appId];
  return {
    appId,
    ownerAgentId: agentId,
    revision: row.revision,
    effective: definition.settings({ ...definition.defaults, ...row.overrides }),
  } as AppConfig;
}

/** Every App's effective configuration for the Agent: its stored row, or its defaults. */
const effectiveConfigs = (agentId: string, rows: StoredAgentAppConfig[]): AppConfig[] =>
  APP_IDS.map((appId) =>
    effectiveConfig(
      agentId,
      appId,
      readRow(
        agentId,
        appId,
        rows.find((row) => row.appId === appId),
      ),
    ),
  );

/**
 * Agent App configuration: each App's settings for one Agent, and their sync to the daemon that
 * runs it. An Agent with no stored row for an App has that App's defaults at revision 0. The
 * daemon asks for a snapshot when it connects and when an Agent starts; a change is pushed as one
 * upsert, and only to a daemon whose ready advertised `app-config:v1`.
 */
export class AgentAppConfigs {
  constructor(
    private readonly repository: AgentAppConfigRepository,
    private readonly capabilities: AppConfigCapabilityLease,
    private readonly publish: AppConfigPublisher,
  ) {}

  /** Every App's effective configuration for the Agent. */
  async configs(agentId: string): Promise<AppConfig[]> {
    return effectiveConfigs(agentId, await this.repository.list(agentId));
  }

  /** One App's config as its owner Agent reads it (`coforge app config`). */
  async view(agentId: string, appId: string): Promise<AppConfigReadOutcome> {
    if (!isAppConfigAppId(appId)) return { state: "app_not_found" };
    return { state: "found", config: view(appId, await this.#row(agentId, appId)) };
  }

  /**
   * Applies an Agent's change to one of its Apps' config, whole or not at all, if the config is
   * still at `expectedRevision`; then pushes it to the daemon running the Agent (best effort).
   */
  async update(
    agentId: string,
    appId: string,
    patch: AgentAppConfigPatch,
  ): Promise<AppConfigUpdateOutcome> {
    if (!isAppConfigAppId(appId)) return { state: "app_not_found" };
    const { fields } = APP_CONFIG_DEFINITIONS[appId];
    const changed = new Set<string>();
    for (const key of [...patch.unset, ...Object.keys(patch.set)]) {
      if (changed.has(key))
        return { state: "config_invalid", reason: `${key} is changed more than once` };
      if (!Object.hasOwn(fields, key))
        return { state: "config_invalid", reason: `${appId} has no config key ${key}` };
      changed.add(key);
    }
    const reason = appConfigValuesProblem(appId, patch.set);
    if (reason !== undefined) return { state: "config_invalid", reason };
    const current = await this.#row(agentId, appId);
    if (current.revision !== patch.expectedRevision)
      return { state: "revision_conflict", revision: current.revision };
    const overrides: AppConfigValues = { ...current.overrides, ...patch.set };
    for (const key of patch.unset) delete overrides[key];
    if (!(await this.repository.write(agentId, appId, patch.expectedRevision, overrides)))
      return { state: "revision_conflict", revision: (await this.#row(agentId, appId)).revision };
    await this.publishAppConfig(agentId, appId);
    return {
      state: "updated",
      config: view(appId, { revision: patch.expectedRevision + 1, overrides }),
    };
  }

  async #row(agentId: string, appId: AppConfigAppId): Promise<ReadRow> {
    return readRow(agentId, appId, await this.repository.get(agentId, appId));
  }

  async snapshotForDaemon(request: AppConfigSnapshotRequest): Promise<Uint8Array> {
    const [placement, rows] = await Promise.all([
      this.repository.placement(request.agentId),
      this.repository.list(request.agentId),
    ]);
    if (
      placement?.workspaceId !== request.workspaceId ||
      placement.computerId !== request.computerId
    )
      throw new Error("app config snapshot is not authorized");
    return encodeAppConfigSync({
      ...request,
      operation: "snapshot",
      configs: effectiveConfigs(request.agentId, rows),
      messageType: APP_CONFIG_SYNC_MESSAGE_TYPE,
    });
  }

  /**
   * Pushes one App's current configuration to the daemon running the Agent. Best effort: whether
   * it was sent. One not sent reaches the daemon in its next snapshot.
   */
  async publishAppConfig(agentId: string, appId: string): Promise<boolean> {
    if (!isAppConfigAppId(appId)) return false;
    const placement = await this.repository.placement(agentId);
    const computerId = placement?.computerId;
    if (!placement || !computerId) return false;
    try {
      const [supported, configs] = await Promise.all([
        this.capabilities.supports(placement.workspaceId, computerId),
        this.configs(agentId),
      ]);
      if (!supported) return false;
      await this.publish({
        protocolMajor: APP_CONFIG_PROTOCOL_MAJOR,
        requestId: crypto.randomUUID(),
        workspaceId: placement.workspaceId,
        computerId,
        agentId,
        operation: "upsert",
        configs: configs.filter((config) => config.appId === appId),
        messageType: APP_CONFIG_SYNC_MESSAGE_TYPE,
      });
      return true;
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "agent_app_config:publish_failed",
          agent_id: agentId,
          app_id: appId,
          workspace_id: placement.workspaceId,
          computer_id: computerId,
          error_code: errorType(error),
        }),
      );
      return false;
    }
  }
}
