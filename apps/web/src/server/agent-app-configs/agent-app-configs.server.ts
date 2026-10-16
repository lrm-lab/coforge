import {
  APP_CONFIG_DEFINITIONS,
  APP_CONFIG_PROTOCOL_MAJOR,
  APP_CONFIG_SYNC_MESSAGE_TYPE,
  encodeAppConfigSync,
  isAppConfigAppId,
  type AppConfig,
  type AppConfigAppId,
  type AppConfigSnapshotRequest,
  type AppConfigSync,
} from "@lrm/coforge-sdk/internal";
import { errorType } from "#src/server/errors/error-type.server";

/** One stored row: an App's settings for an Agent, as written. */
export type StoredAgentAppConfig = { appId: string; revision: number; config: unknown };

export interface AgentAppConfigRepository {
  /** Where a live (not deleted) Agent runs, or `undefined` for no such Agent. */
  placement(
    agentId: string,
  ): Promise<{ workspaceId: string; computerId: string | null } | undefined>;
  list(agentId: string): Promise<StoredAgentAppConfig[]>;
}

export interface AppConfigCapabilityLease {
  supports(workspaceId: string, computerId: string): Promise<boolean>;
}

export type AppConfigPublisher = (sync: AppConfigSync) => Promise<void>;

const APP_IDS = Object.keys(APP_CONFIG_DEFINITIONS) as AppConfigAppId[];

function effectiveConfig(
  agentId: string,
  appId: AppConfigAppId,
  row: StoredAgentAppConfig | undefined,
): AppConfig {
  const definition = APP_CONFIG_DEFINITIONS[appId];
  return {
    appId,
    ownerAgentId: agentId,
    revision: row?.revision ?? 0,
    effective: row ? definition.validate(row.config) : definition.defaults,
  };
}

/** Every App's effective configuration for the Agent: its stored row, or its defaults. */
const effectiveConfigs = (agentId: string, rows: StoredAgentAppConfig[]): AppConfig[] =>
  APP_IDS.map((appId) =>
    effectiveConfig(
      agentId,
      appId,
      rows.find((row) => row.appId === appId),
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
