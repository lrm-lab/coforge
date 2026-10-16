import { getLogger } from "@logtape/logtape";
import type { AppConfig, AppConfigAppId, AppConfigSync } from "@lrm/coforge-sdk/internal";
import { diagnosticErrorName } from "#src/platform/diagnostic-error-code";

const logger = getLogger(["coforge", "daemon", "agent-app-config"]);

/** One App's configuration as its runtime takes it: the identity and revision beside the App's
 * own settings. */
export type FlatAppConfig = {
  appId: string;
  ownerAgentId: string;
  revision: number;
} & AppConfig["effective"];

/** The runtime of one Agent App that has configuration. It owns revision fencing. */
export type AppConfigTarget = {
  applyConfig(raw: FlatAppConfig): unknown;
  /** Replaces the owner's configuration with this one, or removes it when `null`. */
  replaceOwnerSnapshot(ownerAgentId: string, raw: FlatAppConfig | null): unknown;
};

const flat = ({ appId, ownerAgentId, revision, effective }: AppConfig): FlatAppConfig => ({
  appId,
  ownerAgentId,
  revision,
  ...effective,
});

/**
 * The daemon's side of Agent App configuration sync. The cloud is authoritative: this asks for an
 * owner Agent's snapshot at most once per connection, and routes each received config to the
 * runtime of its App. Nothing is persisted, and nothing is reported back to the cloud.
 */
export class AgentAppConfigSync {
  readonly #requested = new Set<string>();
  /** Which connection a request belongs to: a later one asks again, so an older answer is
   * dropped. */
  #connection = 0;

  constructor(
    private readonly options: {
      requestSnapshot(agentId: string): Promise<AppConfigSync>;
      apps: Partial<Record<AppConfigAppId, AppConfigTarget>>;
    },
  ) {}

  /** A new cloud connection: every owner's snapshot may be asked for again. */
  connected(): void {
    this.#connection++;
    this.#requested.clear();
  }

  /** Asks for and applies the owner's snapshot, unless this connection already asked. A failed
   * request may be asked again; an answer that arrives after a newer connection is dropped. */
  async request(agentId: string): Promise<void> {
    if (this.#requested.has(agentId)) return;
    this.#requested.add(agentId);
    const connection = this.#connection;
    const snapshot = await this.options.requestSnapshot(agentId).catch((error: unknown) => {
      if (connection === this.#connection) this.#requested.delete(agentId);
      throw error;
    });
    if (connection !== this.#connection) return;
    if (snapshot.agentId !== agentId) throw new Error("app config snapshot for another Agent");
    this.apply(snapshot);
  }

  apply(sync: AppConfigSync): void {
    if (sync.operation === "upsert") {
      for (const config of sync.configs)
        this.#deliver(sync, config.appId, (target) => target.applyConfig(flat(config)));
      return;
    }
    for (const [appId, target] of Object.entries(this.options.apps) as [
      AppConfigAppId,
      AppConfigTarget,
    ][]) {
      const config = sync.configs.find((item) => item.appId === appId);
      this.#deliver(sync, appId, () =>
        target.replaceOwnerSnapshot(sync.agentId, config ? flat(config) : null),
      );
    }
  }

  #deliver(sync: AppConfigSync, appId: AppConfigAppId, run: (target: AppConfigTarget) => unknown) {
    const target = this.options.apps[appId];
    if (!target) return;
    const refused = (error: unknown) =>
      logger.warn("An Agent App refused its configuration", {
        event: "agent_app_config:apply_failed",
        app_id: appId,
        agent_id: sync.agentId,
        operation: sync.operation,
        error_code: diagnosticErrorName(error),
      });
    try {
      void Promise.resolve(run(target)).catch(refused);
    } catch (error) {
      refused(error);
    }
  }
}
