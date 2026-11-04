import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";

/**
 * An Agent's several questions on one card (task #515): it shows as its own card, not another
 * kind's ("Add Members" on staging), with each question's options to tick, the recommendation
 * marked and an own-answer row. Submit stays off until every question has an answer, then sends
 * them all at once; answered, it is still a card, each question over its answer. Opt-in like the
 * other browser E2Es; the channel, Agent and card are seeded per run and removed after it.
 * Screenshots are written under `.amp/e2e/questions-card/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/questions-card");

test("a questions card takes an answer for every question, then sends them at once", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `questions-card-${process.pid}`);
  const { workspaceId, workspace } = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id },
    include: { workspace: { select: { slug: true } } },
  });
  const tail = `${process.pid}-${Date.now()}`.slice(-5);
  const agent = await db.agent.create({
    data: {
      workspaceId,
      name: `e2e-questions-${tail}`,
      displayName: `Questions Agent ${tail}`,
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
      channelName: `e2e-questions-${tail}`,
      description: "",
      members: { create: [{ userId: DEV_BROWSER_USER.id }, { agentId: agent.id }] },
    },
    include: { members: true },
  });
  const agentMember = channel.members.find((member) => member.agentId === agent.id)!;
  const message = await db.message.create({
    data: {
      workspaceId,
      conversationId: channel.id,
      sequence: 1,
      senderMemberId: agentMember.id,
      body: `A few questions before sign-up goes live ${tail}`,
    },
  });
  await db.conversation.update({ where: { id: channel.id }, data: { lastSequence: 1 } });
  await db.actionCard.create({
    data: {
      messageId: message.id,
      conversationId: channel.id,
      workspaceId,
      kind: "questions",
      payload: {
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
        to: DEV_BROWSER_USER.id,
      },
      preparedByAgentId: agent.id,
    },
  });
  const card = `document.querySelector('[data-message-id="${message.id}"] [data-questions-card]')`;
  const cardText = `(${card}?.textContent ?? "")`;
  const submit = `[...(${card}?.querySelectorAll("button") ?? [])].find((el) => el.textContent.includes("Submit"))`;
  const shoot = async (name: string) => {
    await browser("wait", "300");
    await browser("screenshot", join(artifacts, `${name}.png`));
    await evaluate(`document.documentElement.classList.add("dark-mode") ?? true`);
    await browser("wait", "300");
    await browser("screenshot", join(artifacts, `${name}-dark.png`));
    await evaluate(`document.documentElement.classList.remove("dark-mode") ?? true`);
  };
  try {
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1280", "900");
    await browser("open", `${origin}/en/w/${workspace.slug}/channel/${channel.id}`);
    await browser("wait", "--fn", `${pageHydrated} && ${cardText}.includes("Who hears")`);
    // Its own card, never another kind's title or buttons.
    expect(await evaluate<boolean>(`${cardText}.includes("Add Members")`)).toBe(false);
    expect(await evaluate<boolean>(`${cardText}.includes("Recommended")`)).toBe(true);
    expect(await evaluate<boolean>(`${cardText}.includes("0 of 3 answered")`)).toBe(true);
    expect(await evaluate<boolean>(`${submit}?.disabled === true`)).toBe(true);
    await evaluate(`(${card}.scrollIntoView({ block: "center" }), true)`);
    await shoot("waiting");

    // One pick, the person's own words, and two of several: only then can it be sent.
    await browser("click", `[data-question="webhook"] [data-question-option="keep"]`);
    await browser("fill", `[data-question="agent"] [data-question-other]`, "Ask me each time");
    await browser("click", `[data-question="notify"] [data-question-option="ops"]`);
    expect(await evaluate<boolean>(`${submit}?.disabled === true`)).toBe(false);
    await browser("click", `[data-question="notify"] [data-question-option="owner"]`);
    await browser("wait", "--fn", `${cardText}.includes("3 of 3 answered")`);
    await shoot("ready");

    await browser("find", "role", "button", "click", "--name", "Submit");
    await browser("wait", "--fn", `${submit} == null && ${cardText}.includes("Ops, Owner")`);
    const stored = await db.actionCard.findUniqueOrThrow({ where: { messageId: message.id } });
    expect(stored.state).toBe("executed");
    const answers = (stored.result as { answers: { questionId: string; selection: unknown[] }[] })
      .answers;
    expect(answers.map((answer) => answer.questionId)).toEqual(["webhook", "agent", "notify"]);
    // Answered, still a card: each question over what was chosen.
    expect(await evaluate<boolean>(`${cardText}.includes("Ask me each time")`)).toBe(true);
    await shoot("answered");

    // Read again on a phone: the stored answers, as anyone opening the channel later sees them.
    await browser("set", "viewport", "390", "844");
    await browser("open", `${origin}/en/w/${workspace.slug}/channel/${channel.id}`);
    await browser("wait", "--fn", `${pageHydrated} && ${cardText}.includes("Ops, Owner")`);
    await evaluate(`(${card}.scrollIntoView({ block: "center" }), true)`);
    await shoot("phone-answered");
  } finally {
    await browser("close").catch(() => undefined);
    await db.conversation.deleteMany({ where: { id: channel.id } }).catch(() => undefined);
    await db.agent.deleteMany({ where: { id: agent.id } }).catch(() => undefined);
    await db.$disconnect();
  }
}, 180_000);
