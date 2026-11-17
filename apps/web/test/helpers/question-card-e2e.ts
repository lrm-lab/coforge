import { expect } from "bun:test";
import type { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import type { browserSession } from "./browser-e2e";

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

/** How the desktop questions-card e2e reads and works a card: `messageId` is the viewer's card,
 * and a query given another card's id reads that one. */
export function questionCardQueries(
  messageId: string,
  { browser, evaluate }: Pick<ReturnType<typeof browserSession>, "browser" | "evaluate">,
) {
  const card = (id: string) =>
    `document.querySelector('[data-message-id="${id}"] [data-question-card]')`;
  const scoped = (id: string, selector: string) => `[data-message-id="${id}"] ${selector}`;
  const cardText = `(${card(messageId)}?.textContent ?? "")`;
  const onQuestion = (index: number, id = messageId) =>
    `${card(id)}?.dataset.questionAt === "${index}"`;
  const picked = (option: string, id = messageId) =>
    `document.querySelector('${scoped(id, `[data-question-option="${option}"]`)}')?.getAttribute("aria-selected") === "true"`;
  const send = scoped(messageId, "button[data-question-send]");
  const nextButton = scoped(messageId, "button[data-question-next]");
  const nextLabel = `document.querySelector('${nextButton}')?.textContent.trim()`;
  const draftKey = `coforge.question-draft:${messageId}`;
  const highlighted = (id = messageId) =>
    evaluate<string | null>(
      `${card(id)}.querySelector("[data-question-option][data-hi]")?.dataset.questionOption ?? null`,
    );
  /** Moves the highlight onto `option` with the arrow keys; the first press only shows it. */
  const highlightTo = async (option: string, id = messageId) => {
    for (const key of ["ArrowDown", "ArrowDown", "ArrowDown", "ArrowUp", "ArrowUp", "ArrowUp"]) {
      if ((await highlighted(id)) === option) return;
      await browser("press", key);
    }
    expect(await highlighted(id)).toBe(option);
  };
  const listFocused = (id = messageId) =>
    `${card(id)}.querySelector("[data-question-options]")?.contains(document.activeElement) === true`;
  const rows = (id: string) =>
    evaluate<string[]>(
      `[...${card(id)}.querySelectorAll("[data-question-answer]")].map((row) => row.dataset.questionAnswer)`,
    );
  const answerRow = (id: string, question: string) =>
    `(${card(id)}.querySelector('[data-question-answer="${question}"]')?.textContent ?? "")`;
  return {
    card,
    scoped,
    cardText,
    onQuestion,
    picked,
    send,
    nextButton,
    nextLabel,
    draftKey,
    highlighted,
    highlightTo,
    listFocused,
    rows,
    answerRow,
  };
}
