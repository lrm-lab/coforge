import { WORKSPACE_ASSISTANT_KIND } from "#src/features/agents/agent-system-kind";
import { AGENT_PROFILE_DESCRIPTION_MAX_LENGTH } from "#src/features/agents/agent.schemas";
import { agentDirectKey } from "#src/features/conversations/direct-key";
import { isPersonRole } from "#src/features/onboarding/person-role";
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
  /** The owner's first-sign-in setup wizard in this Workspace has not finished
   * (`WorkspaceMemberPreference.onboardingPendingSince`). A platform assistant stays silent until
   * it has. */
  onboardingPending?: boolean;
  /** What the owner said they mainly do (`UserPreference.role`), read each time the prompt is
   * made so a recovery retry still has it. */
  ownerRole?: string | null;
  /** Whether the assistant's owner is to be welcomed by it: recorded when they joined
   * (`WorkspaceMembership.assistantWelcome`), whatever the Workspace's mode is now. Absent reads
   * as true. */
  assistantWelcome?: boolean;
  /** The Agent is also to introduce itself in `#general`: its Workspace asks new Agents to, the
   * Agent is public and `#general` is not hidden. Read where the Start's facts are, never here. */
  greetGeneral?: boolean;
};

/** What the welcome offers next: a starter team suited to a known role, else a question about
 * their work. The role is never asked for here; it was asked once, in the setup wizard. */
function starterTeamAdvice(role: string | null | undefined) {
  if (isPersonRole(role))
    return [
      `The member told CoForge they work as: ${role}. Never ask for their role.`,
      `Offer to propose a starter team of Agents suited to a ${role}, and create Agents only after the member agrees to your proposal.`,
    ].join(" ");
  return "You do not know what the member does, and you must never ask for their job title or role; ask what they are working on instead.";
}

/**
 * The prompt a Start carries while the Agent owes its creator an introduction by DM, else
 * undefined. Ordinary introductions expire; the platform assistant keeps owing its first welcome.
 */
export function introductionPromptFor(facts: AgentIntroductionFacts, now: Date) {
  const { introductionDueAt, deletedAt, ownerUsername: creator } = facts;
  const platformAssistant = facts.systemKind === WORKSPACE_ASSISTANT_KIND;
  if (deletedAt || !creator) return undefined;
  // The owner's setup wizard has not finished: the welcome is still owed, and nothing settles it.
  if (platformAssistant && facts.onboardingPending) return undefined;
  // A platform assistant provisioned before `introductionDueAt` existed still owes its welcome.
  if (
    !platformAssistant &&
    (!introductionDueAt ||
      now.getTime() - introductionDueAt.getTime() > AGENT_INTRODUCTION_WINDOW_MS)
  )
    return undefined;
  if (platformAssistant) {
    // Someone else welcomed the member when they joined, or nobody did.
    if (facts.assistantWelcome === false) return undefined;
    return [
      "You are this member’s private CoForge platform assistant, ready for your first conversation.",
      `Proactively send @${creator} a short friendly welcome in their DM using \`coforge message send --target '@${creator}'\`.`,
      "Introduce yourself and explain that you can help with platform features, messages/channels, Tasks/Projects, reminders and weekly reports, within this member’s permissions.",
      "Tell them that Agents are teammates in CoForge: they message an Agent like a colleague, in a DM or a channel.",
      starterTeamAdvice(facts.ownerRole),
      "The browser supplies five clickable starter choices below your welcome; do not print a second menu or claim email/calendar integrations that are unavailable.",
      `If @${creator} has already written, answer their request and introduce yourself in the same reply; do not interrupt with an onboarding questionnaire.`,
      "Send just one welcome; never post it in a channel. If you already welcomed this member, take no further action.",
      "Use the member’s language, or Chinese when unknown.",
    ].join(" ");
  }
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
    facts.greetGeneral
      ? `Send that introduction to @${creator} only as a direct message; never post it in a channel. Then post a separate two-to-three sentence self-introduction in #general with \`coforge message send --target '#general'\`: who you are, what you do, and how to reach you. Post it once; skip it if you already have in #general.`
      : "Never post this introduction in a channel.",
    "A local final answer is not a delivered message; execute the message send to deliver your reply. After sending a greeting with no request to act on, end this turn and wait.",
    language,
  ].join(" ");
}

export interface AgentIntroductionStore {
  /** What the platform assistant's welcome reads about its owner: whether their setup wizard in
   * this Workspace is still pending (`WorkspaceMemberPreference.onboardingPendingSince`), and
   * their saved role (`UserPreference.role`). */
  setupFacts(
    workspaceId: string,
    ownerId: string,
  ): Promise<{ onboardingPending: boolean; ownerRole: string | null }>;
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
  /** What the Workspace asks of an introduction: whether the Agent's owner is to be welcomed by
   * it (their membership's record) and whether this Agent also says hello in `#general`. Read only
   * for an Agent that may owe one. */
  workspaceFacts(
    agent: AgentIntroductionSubject,
  ): Promise<Pick<AgentIntroductionFacts, "assistantWelcome" | "greetGeneral">>;
}

/** The Agent a Start is for, with what its introduction reads. */
export type AgentIntroductionSubject = AgentIntroductionFacts & {
  id: string;
  workspaceId: string;
  ownerId: string;
  visibility?: string;
};

/**
 * The introduction a Start carries, settled from the canonical Messages: once the Agent has a
 * message in its creator's DM since the introduction fell due, it introduced itself, however its
 * send went.
 */
export class AgentIntroduction {
  constructor(private readonly store: AgentIntroductionStore) {}

  /**
   * Whether no Start may be issued for this Agent yet: a platform assistant whose owner's setup
   * wizard in its Workspace is still pending. The one question every Start that the member did not
   * ask for puts first (`AgentControl.recover`: Daemon ready recovery and a message's wake;
   * `startAssistantIfOwed`), since a started assistant is no longer re-bindable by the wizard and
   * would greet before it finishes. An unreadable mark holds the Start too (fail closed).
   */
  async holdsStart(agent: {
    id: string;
    workspaceId: string;
    ownerId: string;
    systemKind?: string | null;
  }): Promise<boolean> {
    if (agent.systemKind !== WORKSPACE_ASSISTANT_KIND) return false;
    const setup = await this.#setupOf(agent);
    return !setup || setup.onboardingPending === true;
  }

  /** The owner's setup facts, or undefined (logged) when they cannot be read. */
  async #setupOf(agent: { id: string; workspaceId: string; ownerId: string }) {
    try {
      return await this.store.setupFacts(agent.workspaceId, agent.ownerId);
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "agent_introduction:setup_unreadable",
          workspace_id: agent.workspaceId,
          agent_id: agent.id,
          error_type: errorType(error),
        }),
      );
      return undefined;
    }
  }

  /**
   * The prompt this Start carries: undefined when none is owed, and when the Agent has already
   * introduced itself, which settles it. Only an Agent that still owes one is read. A failed read or
   * settle is logged and the prompt is carried; it never blocks the Start.
   */
  async promptFor(subject: AgentIntroductionSubject, now: Date): Promise<string | undefined> {
    if (!introductionPromptFor(subject, now)) return undefined;
    // The Workspace's part is read only now, for an Agent that may owe an introduction: every
    // other Start, and every other read of the Agent, pays nothing for it. Unread, the prompt is
    // the one before these settings existed.
    let agent = subject;
    try {
      agent = { ...subject, ...(await this.store.workspaceFacts(subject)) };
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "agent_introduction:workspace_facts_failed",
          workspace_id: subject.workspaceId,
          agent_id: subject.id,
          error_type: errorType(error),
        }),
      );
    }
    // The welcome waits for the owner's setup wizard and mentions their role, which are read here,
    // when it is made, and only for the platform assistant that still owes one.
    let setup: Pick<AgentIntroductionFacts, "onboardingPending" | "ownerRole"> = {};
    if (agent.systemKind === WORKSPACE_ASSISTANT_KIND) {
      const read = await this.#setupOf(agent);
      if (!read) return undefined;
      setup = read;
    }
    const prompt = introductionPromptFor({ ...agent, ...setup }, now);
    if (!prompt) return undefined;
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
