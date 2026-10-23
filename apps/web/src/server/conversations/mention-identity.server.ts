import type {
  MentionAgentState,
  MentionIdentity,
} from "#src/server/db/repositories/mention-delivery.repositories.server";
import type { MentionDeliveryEnvelope } from "@lrm/coforge-sdk/internal";

/** Whether nothing stops the Agent from being woken: not stopped by a person, not deleted, and on
 * a Computer. */
export function wakeable(agent: MentionAgentState) {
  return !agent.stoppedAt && !agent.deletedAt && agent.computerId !== null;
}

/** The Agent's running launch and native session, when it has both on its current Computer. */
export function currentIdentity(agent: MentionAgentState): MentionIdentity | undefined {
  if (!wakeable(agent)) return undefined;
  const launchId = agent.launch?.launchId;
  const sessionId = agent.session?.nativeSessionId;
  if (
    !launchId ||
    !sessionId ||
    agent.launch?.computerId !== agent.computerId ||
    agent.session?.computerId !== agent.computerId
  )
    return undefined;
  return { launchId, sessionId, computerId: agent.computerId! };
}

export function envelopeFor(messageId: string, identity: MentionIdentity): MentionDeliveryEnvelope {
  return {
    messageId,
    launchId: identity.launchId,
    sessionId: identity.sessionId,
    computerId: identity.computerId,
  };
}
