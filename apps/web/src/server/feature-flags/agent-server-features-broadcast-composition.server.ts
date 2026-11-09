import {
  createCentrifugoServerApi,
  daemonControlChannel,
} from "#src/server/centrifugo/server-api.server";
import { getDatabaseClient } from "#src/server/db/client.server";
import { getAgentContextViewCapabilityLease } from "#src/server/computers/agent-context-view-capability.server";
import { isFeatureEnabled, onFeatureFlagsChanged } from "./feature-flags.server";
import { AgentServerFeaturesBroadcaster } from "./agent-server-features-broadcaster.server";

let installed = false;
let broadcastQueue = Promise.resolve();

/** Installs the process-wide reload hook. A failed broadcast never invalidates the flag reload. */
export function installAgentServerFeaturesBroadcast(): () => void {
  if (installed) return () => {};
  installed = true;
  const publish = () => {
    const db = getDatabaseClient();
    if (!db) return;
    const broadcaster = new AgentServerFeaturesBroadcaster({
      db,
      supports: (workspaceId, computerId) =>
        getAgentContextViewCapabilityLease().supports(workspaceId, computerId),
      enabled: (workspaceId) => isFeatureEnabled("agentContextView", { workspaceId }),
      publish: (workspaceId, computerId, payload) =>
        createCentrifugoServerApi().publish(daemonControlChannel(workspaceId, computerId), payload),
    });
    const run = broadcastQueue.then(() => broadcaster.publishSnapshot());
    broadcastQueue = run.catch((error) => {
      console.warn(
        JSON.stringify({
          event: "feature_flags:agent_context_view_broadcast_failed",
          error_code: error instanceof Error ? error.name : "unknown",
        }),
      );
    });
  };
  const stop = onFeatureFlagsChanged(publish);
  publish();
  return stop;
}
