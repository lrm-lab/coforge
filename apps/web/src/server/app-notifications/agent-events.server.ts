import type { Prisma } from "#src/generated/prisma/client";
import {
  parseAgentRuntimeConfig,
  type AgentRuntimeConfig,
} from "#src/server/agents/agent-runtime-config.server";
import type { AppNotificationEventPayload } from "./app-notification-event";
import { recordAppNotifications } from "./app-notifications.server";

/**
 * What apps are told about an Agent's profile and runtime. Each function runs inside the
 * transaction of the domain write it describes, so the event exists only if that write commits;
 * the data is the Agent id and the changed fields, never the configuration itself (its provider
 * holds an encrypted API key and its environment is the owner's).
 */

type ProfileField = "display_name" | "description" | "avatar";

/** The profile fields that changed; nothing is recorded for none. */
export function recordAgentProfileUpdated(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  agentId: string,
  fields: readonly ProfileField[],
) {
  if (fields.length === 0) return Promise.resolve();
  return recordAppNotifications(tx, { id: workspaceId }, [
    { type: "agent.profile_updated", data: { agent_id: agentId, fields: [...fields] } },
  ]);
}

type Selection = Pick<
  AgentRuntimeConfig,
  "runtime" | "model" | "modelProvider" | "reasoning" | "fastMode"
>;

/**
 * A new runtime configuration against the stored one (`previousStored`, as read from the row; one
 * that does not parse records nothing, the write replaces it anyway): `agent.runtime_changed` when
 * the runtime differs, `agent.model_changed` when the model, its provider, reasoning or fast mode
 * does. Both happen when a change of runtime also changes the model. A change of API key or
 * environment alone is neither. The comparison happens only once the flag is on for the Workspace.
 */
export function recordAgentRuntimeConfigChanged(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  agentId: string,
  previousStored: unknown,
  next: Selection,
) {
  return recordAppNotifications(tx, { id: workspaceId }, async () => {
    const previous: Selection = parseAgentRuntimeConfig(previousStored);
    const events: AppNotificationEventPayload[] = [];
    if (previous.runtime !== next.runtime)
      events.push({
        type: "agent.runtime_changed",
        data: { agent_id: agentId, previous_runtime: previous.runtime, runtime: next.runtime },
      });
    const fields = [
      ...(previous.model !== next.model ? (["model"] as const) : []),
      ...(previous.modelProvider !== next.modelProvider ? (["model_provider"] as const) : []),
      ...(previous.reasoning !== next.reasoning ? (["reasoning"] as const) : []),
      ...((previous.fastMode === true) !== (next.fastMode === true)
        ? (["fast_mode"] as const)
        : []),
    ];
    if (fields.length > 0)
      events.push({
        type: "agent.model_changed",
        data: { agent_id: agentId, fields, previous_model: previous.model, model: next.model },
      });
    return events;
  });
}
