import type { AgentSession } from "@coforge/agent";
import { MENTION_DELIVERY_TERMINAL_CODES } from "@lrm/coforge-sdk/internal";
import type { AgentProcessManager } from "#src/agent-runtime/agent-process-manager";
import type { ActivityLaunch } from "./activity-launch";
import type { AgentActivityPublisher } from "./agent-activity-publisher";
import type { AgentDeliveryGate } from "./agent-delivery-gate";
import { AgentInputDrain } from "./agent-input-drain";
import type { AgentLaunchCustody } from "./agent-launch-custody";
import type { AgentMessageAttentionIndex } from "./agent-message-attention-index";
import type { AgentStopRegistry } from "./agent-stop-registry";
import {
  deliverContextViewMessage,
  type ContextViewRuntimeDeps,
} from "./context-view-runtime-wiring";
import { isTrackedMention, type MentionDeliveryTracker } from "./mention-delivery-tracker";
import type { agentActivityDrafts } from "./agent-activity-drafts";

/** The runtime's collaborators the input drain acts through. Every one is a thunk: the drain is
 * built by a field initializer, before the collaborators it reads are. */
export type InputDrainCollaborators = {
  runnerHeld(): boolean;
  processManager(): AgentProcessManager;
  launches(): ReadonlyMap<string, ActivityLaunch>;
  deliveryGate(): AgentDeliveryGate;
  agentLaunches(): ReadonlyMap<string, unknown>;
  stopState(): Pick<AgentStopRegistry, "stopping">;
  contextView(): ContextViewRuntimeDeps;
  mentionDeliveries(): MentionDeliveryTracker;
  messageAttention(): AgentMessageAttentionIndex;
  launchCustody(): AgentLaunchCustody;
  abandonLaunch(agentId: string, error: unknown): Promise<unknown>;
  activityPublisher(): AgentActivityPublisher<ActivityLaunch>;
  drafts(): ReturnType<typeof agentActivityDrafts>;
  introducedAgents(): Set<string>;
};

/** The input drain over the runtime's collaborators (`AgentInputDrain`). */
export function assembleInputDrain(ports: InputDrainCollaborators): AgentInputDrain {
  return new AgentInputDrain(
    {
      runnerHeld: ports.runnerHeld,
      sessionFor: (agentId) => ports.processManager().session(agentId),
      launchFor: (agentId) => ports.launches().get(agentId),
      hasQueuedDeliveries: (agentId) => ports.deliveryGate().hasQueued(agentId),
      isLaunching: (agentId) => ports.agentLaunches().has(agentId),
      isStopping: (agentId) => ports.stopState().stopping(agentId),
      deliverMessage: (agentId, message) =>
        deliverContextViewMessage(ports.contextView(), agentId, message, () =>
          isTrackedMention(message)
            ? ports.mentionDeliveries().deliver(message)
            : ports.messageAttention().receive(message),
        ),
      runStartup: async (
        agentId: string,
        session: AgentSession,
        launch: ActivityLaunch,
        text: string,
      ) => {
        ports.launchCustody().noteStartupTurn(agentId);
        await launch.startup?.run(session.sendMessage(text));
      },
      runPrompt: (agentId, text, introduction) =>
        ports.launchCustody().runPromptTurn(agentId, text, introduction),
      recoverAttention: (agentId, context) => ports.launchCustody().recover(agentId, context),
      abandonLaunch: ports.abandonLaunch,
      publishStartupError: (agentId, launch, message) =>
        ports
          .activityPublisher()
          .publish(agentId, launch, ports.drafts().runtimeError(agentId, message)),
      forgetIntroduced: (agentId) => ports.introducedAgents().delete(agentId),
      hasCarried: (agentId) => ports.mentionDeliveries().carry.hasCarried(agentId),
      presentKept: (agentId) => ports.launchCustody().flushSurvivingDeliveries(agentId),
      tellCarried: (agentId, alongside) => {
        // Nothing is told under a runner hold: the kept mentions wait for the restart. Nor to a
        // process whose credential is known invalid: they wait for its next launch.
        const taken =
          ports.runnerHeld() || ports.deliveryGate().credentialHeld(agentId)
            ? []
            : ports.mentionDeliveries().carry.takeCarried(agentId);
        return taken.length
          ? ports.mentionDeliveries().carry.tell(taken, alongside)
          : alongside.length
            ? ports.messageAttention().flush(agentId, alongside)
            : Promise.resolve();
      },
      dropMention: (message) =>
        ports.mentionDeliveries().drop(message, MENTION_DELIVERY_TERMINAL_CODES.DELIVERY_REJECTED),
      deliveryConsumption: ports.deliveryGate().consumption,
    },
    ports.deliveryGate().inboxes,
  );
}
