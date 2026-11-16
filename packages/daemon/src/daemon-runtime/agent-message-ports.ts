import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";
import type { AgentContexts } from "./agent-contexts";
import type { AgentInboxStateMachine } from "./agent-inbox-state-machine";
import type { HeldFreshnessActivity } from "./agent-inbox-freshness-activity";
import type { AgentMessageAttentionIndex } from "./agent-message-attention-index";
export type AgentMessageOperationsPorts = Readonly<{
  connection: Readonly<{
    workspaceId: string;
    computerId: string;
  }>;
  attention: AgentMessageAttentionIndex;
  contexts?: Pick<AgentContexts, "ledger">;
  inbox(agentId: string): AgentInboxStateMachine;
  appItemsPending?(agentId: string): Promise<number>;
  readonly transport: Pick<DaemonConnectionClient, "agentMessage" | "reconcileAgentSend">;
  reportFreshnessHold(agentId: string, activity: HeldFreshnessActivity): void;
}>;
