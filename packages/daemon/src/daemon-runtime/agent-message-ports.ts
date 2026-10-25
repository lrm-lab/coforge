import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";
import type { AgentInboxStateMachine } from "./agent-inbox-state-machine";
import type { HeldFreshnessActivity } from "./agent-inbox-freshness-activity";
import type { AgentMessageAttentionIndex } from "./agent-message-attention-index";

export type AgentMessageOperationsPorts = Readonly<{
  connection: Readonly<{ workspaceId: string; computerId: string }>;
  attention: AgentMessageAttentionIndex;
  isMemoryAgent?(agentId: string): boolean;
  /** The Agent's send drafts. */
  inbox(agentId: string): AgentInboxStateMachine;
  /** How many App Inbox items wait for the Agent. */
  appItemsPending?(agentId: string): Promise<number>;
  /** The current transport, read at each request; the runtime has checked it can carry Agent
   * messages. */
  readonly transport: Pick<DaemonConnectionClient, "agentMessage" | "reconcileAgentSend">;
  /** Narrates a held send as the Agent's Activity. */
  reportFreshnessHold(agentId: string, activity: HeldFreshnessActivity): void;
}>;
