import { WORKSPACE_ASSISTANT_KIND } from "#src/features/agents/agent-system-kind";
import { AGENT_PROFILE_DESCRIPTION_MAX_LENGTH } from "#src/features/agents/agent.schemas";
import { agentDirectKey } from "#src/features/conversations/direct-key";
import { errorType } from "#src/server/errors/error-type.server";

/** How long after it fell due an Agent still owes its introduction. */
export const AGENT_INTRODUCTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** What the introduction decision and its prompt read about the Agent: read-model fields that
 * `AgentControlAgent` carries too. */
export type AgentIntroductionFacts = {
  /** Set by creation/provisioning; null once settled or when none is owed. */
  introductionDueAt?: Date | null;
  systemKind?: string | null;
  deletedAt?: Date | null;
  description?: string;
  /** The creator's (`Agent.ownerId`) username. */
  ownerUsername?: string;
};

/**
 * The prompt a Start carries while the Agent owes its creator an introduction by DM, else
 * undefined. Ordinary introductions expire; the platform assistant keeps owing its first welcome.
 */
export function introductionPromptFor(facts: AgentIntroductionFacts, now: Date) {
  const { introductionDueAt, deletedAt, ownerUsername: creator } = facts;
  const platformAssistant = facts.systemKind === WORKSPACE_ASSISTANT_KIND;
  if (deletedAt || !creator) return undefined;
  // A platform assistant provisioned before `introductionDueAt` existed still owes its welcome.
  if (
    !platformAssistant &&
    (!introductionDueAt ||
      now.getTime() - introductionDueAt.getTime() > AGENT_INTRODUCTION_WINDOW_MS)
  )
    return undefined;
  if (platformAssistant)
    return [
      "You are this member’s private CoForge platform assistant, ready for your first conversation.",
      `Proactively send @${creator} a short friendly welcome in their DM using \`coforge message send --target '@${creator}'\`.`,
      "Introduce yourself as 通用助手 and explain that you can help with platform features, messages/channels, Tasks/Projects, reminders and weekly reports, within this member’s permissions.",
      "The browser supplies five clickable starter choices below your welcome; do not print a second menu or claim email/calendar integrations that are unavailable.",
      `If @${creator} has already written, answer their request and introduce yourself in the same reply; do not interrupt with an onboarding questionnaire.`,
      "Send just one welcome; never post it in a channel. If you already welcomed this member, take no further action.",
      "Use the member’s language, or Chinese when unknown.",
    ].join(" ");
  // Create and edit cap a description; a row older than the cap is cut to it.
  const description = (facts.description ?? "")
    .trim()
    .slice(0, AGENT_PROFILE_DESCRIPTION_MAX_LENGTH);
  const [role, language] = description
    ? [
        `In one or two short sentences, say what you are responsible for — your role: ${description} — and that you are ready, then ask what they want your help with.`,
        `Write in the language @${creator} uses with you, or else the language of your role description.`,
      ]
    : [
        "In one or two short sentences, say that you are ready and ask what they want your help with.",
        `Write in the language @${creator} uses with you.`,
      ];
  return [
    "You were just created in CoForge.",
    `Before anything else, introduce yourself to @${creator}, who created you, in a direct message (\`coforge message send --target '@${creator}'\`).`,
    "Do not read memory, list tasks, or scan channels merely to prepare this greeting. If the creator has already sent a request, use the tools needed for that request.",
    role,
    `If @${creator} has already written to you, answer that message and introduce yourself in the same reply.`,
    `If you have already introduced yourself to @${creator} in this session, end this turn without taking action.`,
    "Never post this introduction in a channel.",
    "A local final answer is not a delivered message; execute the message send to deliver your reply. After sending a greeting with no request to act on, end this turn and wait.",
    language,
  ].join(" ");
}

export interface AgentIntroductionStore {
  /** Whether Agent `agentId` sent a message, created at or after `since`, in the direct
   * conversation keyed `directKey`. */
  hasAgentMessage(input: {
    workspaceId: string;
    agentId: string;
    directKey: string;
    since: Date;
  }): Promise<boolean>;
  /** Clears `introductionDueAt` in one conditional update: only while it is set and `ownerId`
   * created the Agent, so a concurrent or repeated settle changes nothing. */
  settle(input: { workspaceId: string; agentId: string; ownerId: string }): Promise<void>;
}

/** The Agent a Start is for, with what its introduction reads. */
export type AgentIntroductionSubject = AgentIntroductionFacts & {
  id: string;
  workspaceId: string;
  ownerId: string;
};

/**
 * The introduction a Start carries, settled from the canonical Messages: once the Agent has a
 * message in its creator's DM since the introduction fell due, it introduced itself, however its
 * send went.
 */
export class AgentIntroduction {
  constructor(private readonly store: AgentIntroductionStore) {}

  /**
   * The prompt this Start carries: undefined when none is owed, and when the Agent has already
   * introduced itself, which settles it. Only an Agent that still owes one is read. A failed read or
   * settle is logged and the prompt is carried; it never blocks the Start.
   */
  async promptFor(agent: AgentIntroductionSubject, now: Date): Promise<string | undefined> {
    const prompt = introductionPromptFor(agent, now);
    if (!prompt) return prompt;
    // A platform assistant with no `introductionDueAt` owes its welcome since it was created;
    // any canonical DM reply of its own settles it and the column stays unset.
    const since =
      agent.introductionDueAt ??
      (agent.systemKind === WORKSPACE_ASSISTANT_KIND ? new Date(0) : undefined);
    if (!since) return prompt;
    const scope = { workspaceId: agent.workspaceId, agentId: agent.id };
    try {
      const introduced = await this.store.hasAgentMessage({
        ...scope,
        directKey: agentDirectKey(agent.ownerId, agent.id),
        since,
      });
      if (!introduced) return prompt;
      await this.store.settle({ ...scope, ownerId: agent.ownerId });
      return undefined;
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "agent_introduction:check_failed",
          workspace_id: agent.workspaceId,
          agent_id: agent.id,
          error_type: errorType(error),
        }),
      );
      return prompt;
    }
  }
}
