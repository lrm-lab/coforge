import { AgentAppInbox } from "#src/agent-app-inbox/agent-app-inbox";
import { AgentInboxStateMachine } from "#src/daemon-runtime/agent-inbox-state-machine";
import { WORKSPACE_PROTOCOL_MAJOR } from "@lrm/coforge-sdk/internal";
import type { AgentStateDb } from "#src/persistence/agent-state-db";

/** The Agent's Inbox state machine, opened once per Agent on its state database. */
export function agentInbox(
  inboxes: Map<string, AgentInboxStateMachine>,
  stateDb: (agentId: string) => AgentStateDb,
  agentId: string,
): AgentInboxStateMachine {
  const existing = inboxes.get(agentId);
  if (existing) return existing;
  const inbox = AgentInboxStateMachine.open(stateDb(agentId));
  inboxes.set(agentId, inbox);
  return inbox;
}

/** The Agent's App Inbox, opened once per Agent; the map holds the open Promise so concurrent
 * first uses share it. */
export function appInbox(
  inboxes: Map<string, Promise<AgentAppInbox>>,
  stateDirectory: string,
  workspaceId: string,
  agentId: string,
): Promise<AgentAppInbox> {
  const existing = inboxes.get(agentId);
  if (existing) return existing;
  const opened = AgentAppInbox.open(stateDirectory, workspaceId, agentId);
  inboxes.set(agentId, opened);
  return opened;
}

/** The identity every Workspace-scoped request or report shares. */
export function workspaceEnvelope(workspaceId: string, computerId: string) {
  return {
    protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
    requestId: crypto.randomUUID(),
    workspaceId,
    computerId,
  };
}
