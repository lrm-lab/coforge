import type { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";

export const IN_COMPOSER = `document.querySelector("[data-composer]").contains(document.activeElement)`;
export const FOCUS_COMPOSER = `(() => { const c = document.querySelector("[data-composer]"); (c.querySelector("textarea, input, [contenteditable]") ?? c).focus(); return true; })()`;

export async function seedQuestionChannel(
  db: PrismaClient,
  workspaceId: string,
  names: { peer: string; agent: string; agentDisplayName: string; channel: string },
) {
  const peer = await db.user.create({
    data: { username: names.peer, displayName: "Asked Peer" },
  });
  await db.workspaceMembership.create({ data: { workspaceId, userId: peer.id } });
  const agent = await db.agent.create({
    data: {
      workspaceId,
      name: names.agent,
      displayName: names.agentDisplayName,
      ownerId: DEV_BROWSER_USER.id,
      runtimeConfig: {
        runtime: "pi",
        provider: { kind: "default" },
        model: "",
        modelProvider: "",
        reasoning: "",
      },
    },
  });
  const channel = await db.conversation.create({
    data: {
      workspaceId,
      channelName: names.channel,
      description: "",
      members: {
        create: [{ userId: DEV_BROWSER_USER.id }, { userId: peer.id }, { agentId: agent.id }],
      },
    },
    include: { members: true },
  });
  const agentMember = channel.members.find((member) => member.agentId === agent.id)!;
  return { peer, agent, channel, agentMember };
}

export async function postCard(
  db: PrismaClient,
  workspaceId: string,
  seeded: Pick<
    Awaited<ReturnType<typeof seedQuestionChannel>>,
    "agent" | "channel" | "agentMember"
  >,
  card: { sequence: number; body: string; kind: "choice" | "questions"; payload: object },
) {
  const message = await db.message.create({
    data: {
      workspaceId,
      conversationId: seeded.channel.id,
      sequence: card.sequence,
      senderMemberId: seeded.agentMember.id,
      body: card.body,
    },
  });
  await db.actionCard.create({
    data: {
      messageId: message.id,
      conversationId: seeded.channel.id,
      workspaceId,
      kind: card.kind,
      payload: card.payload,
      preparedByAgentId: seeded.agent.id,
    },
  });
  return message.id;
}

export const signUpQuestions = (tail: string, to: string) => ({
  type: "questions",
  prompt: `Sign-up automation ${tail}`,
  questions: [
    {
      id: "webhook",
      prompt: "Set up the webhook so sign-ups get the Free tier at once?",
      select: "one",
      options: [
        { id: "keep", label: "Keep it manual", recommended: true },
        { id: "auto", label: "Automate it", description: "Every sign-up, no review" },
      ],
      other: {},
    },
    {
      id: "agent",
      prompt: "Which built-in Agent do new members get?",
      select: "one",
      options: [
        { id: "helper", label: "Helper" },
        { id: "none", label: "None" },
      ],
      other: {},
    },
    {
      id: "notify",
      prompt: "Who hears about a new sign-up?",
      select: "many",
      options: [
        { id: "ops", label: "Ops" },
        { id: "sales", label: "Sales" },
        { id: "owner", label: "Owner" },
      ],
    },
  ],
  to,
});
