import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";
import { setAgentApiKeyHealer } from "#src/connection/agent-http-wire";
import { requestAgentLaunchConfig } from "./agent-launch-config";

/** What healing a rejected Agent API key needs from the runtime. */
export type AgentApiKeyHealPorts = {
  /** The live Agent API key registry: Agent id to the key its process currently holds. */
  agentApiKeys: Map<string, string>;
  workspaceId: () => string;
  transport: () => DaemonConnectionClient | undefined;
  /** The Agent's remembered server launch identity; a managed Agent's refresh is refused
   * without it. */
  managedScope?: (
    agentId: string,
  ) => { controlEpoch?: number; requestId: string; launchId: string } | undefined;
  /** Whether the Agent still has a live launch here — a stopped Agent's 401 is final. */
  launchAlive: (agentId: string) => boolean;
  now?: () => number;
};

const HEAL_LIMIT_PER_AGENT = 3;
const HEAL_WINDOW_MS = 10 * 60_000;
const HEAL_MIN_INTERVAL_MS = 5_000;

/**
 * Answers a 401-rejected Agent API key with a freshly minted one: finds the Agent the rejected
 * key belongs to, asks the cloud for a new launch credential and swaps the registry entry, so
 * the retried call authenticates. The cloud's mint is itself Agent-state fenced — a deleted or
 * stopped Agent's mint is refused and nothing is returned — and the daemon only asks while the
 * Agent's launch lives, so an intentional revocation can never be healed past. Rejected keys a
 * heal already replaced resolve to the replacement without minting again, so concurrent calls
 * sharing the dead key all recover on their retry. Bounded per Agent per window: a cloud that
 * keeps refusing cannot be mint-stormed.
 */
export function createAgentApiKeyHealer(
  ports: AgentApiKeyHealPorts,
): (rejectedKey: string) => Promise<string | undefined> {
  const heals = new Map<string, number[]>();
  const superseded = new Map<string, string>();
  const now = ports.now ?? Date.now;
  return async (rejectedKey) => {
    let agentId: string | undefined;
    for (const [id, key] of ports.agentApiKeys) {
      if (key === rejectedKey) {
        agentId = id;
        break;
      }
    }
    agentId ??= superseded.get(rejectedKey);
    if (agentId === undefined) return undefined;
    // A concurrent call may already have healed this Agent; hand its key back without minting.
    const current = ports.agentApiKeys.get(agentId);
    if (current !== undefined && current !== rejectedKey) return current;
    if (!ports.launchAlive(agentId)) return undefined;
    const transport = ports.transport();
    if (!transport || (!transport.requestAgentLaunchConfig && !transport.requestAgentApiKey))
      return undefined;
    const at = now();
    const recent = (heals.get(agentId) ?? []).filter((t) => at - t < HEAL_WINDOW_MS);
    if (
      recent.length >= HEAL_LIMIT_PER_AGENT ||
      (recent.length > 0 && at - recent[recent.length - 1]! < HEAL_MIN_INTERVAL_MS)
    )
      return undefined;
    heals.set(agentId, [...recent, at]);
    try {
      const config = await requestAgentLaunchConfig(
        transport,
        ports.workspaceId(),
        agentId,
        ports.managedScope?.(agentId),
      );
      // A racing launch may have installed a newer key while the mint was in flight; never
      // overwrite it, and hand that key back so this retry uses what the process holds.
      const installed = ports.agentApiKeys.get(agentId);
      if (installed !== rejectedKey) return installed;
      ports.agentApiKeys.set(agentId, config.agentApiKey);
      if (superseded.size >= 256) superseded.delete(superseded.keys().next().value!);
      superseded.set(rejectedKey, agentId);
      return config.agentApiKey;
    } catch {
      return undefined;
    }
  };
}

/** Installs the healer on the shared Agent HTTPS transport; the runtime that owns the key
 * registry calls this once, from the collaborator that already holds its ports. The install is
 * process-global: correct because one daemon process runs one Workspace runtime — a second
 * runtime in the same process (tests) shares the last install and fails closed through its own
 * ports. */
export function installAgentApiKeyHealer(ports: AgentApiKeyHealPorts): void {
  setAgentApiKeyHealer(createAgentApiKeyHealer(ports));
}
