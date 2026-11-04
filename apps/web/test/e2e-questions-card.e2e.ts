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
  // The same questions asked of someone else: the viewer only sees them, and whom they wait on.
  const other = await db.workspaceMembership.findFirst({
    where: { workspaceId, userId: { not: DEV_BROWSER_USER.id } },
    select: { userId: true },
  });
  const otherMessage =
    other &&
    (await db.message.create({
      data: {
        workspaceId,
        conversationId: channel.id,
        sequence: 2,
        senderMemberId: agentMember.id,
        body: `And for someone else ${tail}`,
      },
    }));
  if (otherMessage && other) {
    await db.conversation.update({ where: { id: channel.id }, data: { lastSequence: 2 } });
    const asked = await db.actionCard.findUniqueOrThrow({ where: { messageId: message.id } });
    await db.actionCard.create({
      data: {
        messageId: otherMessage.id,
        conversationId: channel.id,
        workspaceId,
        kind: "questions",
        payload: { ...(asked.payload as object), to: other.userId },
        preparedByAgentId: agent.id,
      },
    });
  }
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
    const shown = (id: string) => `${card}?.querySelector('[data-question="${id}"]') != null`;
    const button = (name: string) =>
      `[...(${card}?.querySelectorAll("button") ?? [])].find((el) => el.textContent.trim() === ${JSON.stringify(name)})`;
    const press = async (name: string) => {
      await evaluate(`(${button(name)}.setAttribute("data-e2e-press", ""), true)`);
      await browser("click", "[data-e2e-press]");
      await evaluate(
        `(document.querySelector("[data-e2e-press]")?.removeAttribute("data-e2e-press"), true)`,
      );
    };
    await browser("set", "viewport", "1280", "900");
    await browser("open", `${origin}/en/w/${workspace.slug}/channel/${channel.id}`);
    await browser("wait", "--fn", `${pageHydrated} && ${cardText}.includes("Set up the webhook")`);
    // Its own card, never another kind's; one question at a time, every row's key in sight.
    expect(await evaluate<boolean>(`${cardText}.includes("Add Members")`)).toBe(false);
    expect(await evaluate<number>(`${card}.querySelectorAll("[data-question]").length`)).toBe(1);
    expect(await evaluate<number>(`${card}.querySelectorAll("kbd").length`)).toBe(3);
    expect(await evaluate<boolean>(`${button("Skip")} != null`)).toBe(true);
    await evaluate(`(${card}.scrollIntoView({ block: "center" }), true)`);
    await shoot("step-1");

    // A single pick moves on by itself; ← → turn the questions and an answer stays given.
    await browser("click", `[data-question="webhook"] [data-question-option="keep"]`);
    await browser("wait", "--fn", shown("agent"));
    await browser("press", "ArrowLeft");
    await browser("wait", "--fn", shown("webhook"));
    expect(
      await evaluate<boolean>(
        `${card}?.querySelector('[data-question-option="keep"]')?.hasAttribute("data-selected") ?? false`,
      ),
    ).toBe(true);
    // Answered, the way on is Next.
    expect(await evaluate<boolean>(`${button("Next")} != null`)).toBe(true);
    await browser("press", "ArrowRight");
    await browser("wait", "--fn", shown("agent"));

    // A question may be skipped.
    await press("Skip");
    await browser("wait", "--fn", shown("notify"));
    // Several picks wait; the last question sends.
    await browser("press", "1");
    await browser("press", "3");
    await browser("wait", "400");
    expect(await evaluate<boolean>(shown("notify"))).toBe(true);
    expect(await evaluate<boolean>(`${submit}?.disabled === false`)).toBe(true);
    await shoot("step-many");
    // A dot goes straight back to its question; its own words, then Enter, go on.
    await browser("click", `[data-questions-card] [aria-label="Question 2"]`);
    await browser("wait", "--fn", shown("agent"));
    await browser("fill", `[data-question="agent"] [data-question-other]`, "Ask me each time");
    await shoot("step-other");
    await browser("press", "Enter");
    await browser("wait", "--fn", shown("notify"));

    // On a phone (the narrow layout draws the card afresh) a sideways swipe turns the questions.
    await browser("set", "viewport", "390", "844");
    await browser("wait", "--fn", shown("webhook"));
    await evaluate(`(${card}.scrollIntoView({ block: "center" }), true)`);
    await shoot("phone-step");
    const swipe = (dx: number) =>
      evaluate(`(() => {
        const el = ${card}.querySelector("[data-question]");
        const r = el.getBoundingClientRect();
        const at = (x) => new Touch({ identifier: 1, target: el, clientX: x, clientY: r.top + 20 });
        const x = r.left + r.width / 2;
        el.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, touches: [at(x)], changedTouches: [at(x)] }));
        el.dispatchEvent(new TouchEvent("touchend", { bubbles: true, touches: [], changedTouches: [at(x + ${dx})] }));
        return true;
      })()`);
    await swipe(-90);
    await browser("wait", "--fn", shown("agent"));
    await swipe(90);
    await browser("wait", "--fn", shown("webhook"));
    await browser("click", `[data-question="webhook"] [data-question-option="keep"]`);
    await browser("wait", "--fn", shown("agent"));
    await press("Skip");
    await browser("wait", "--fn", shown("notify"));
    await browser("click", `[data-question="notify"] [data-question-option="ops"]`);
    await browser("click", `[data-question="notify"] [data-question-option="owner"]`);

    // Offline, the send fails: the card says so and keeps every answer for another try.
    await browser("set", "offline", "on");
    await press("Submit");
    await browser("wait", "--fn", `${card}?.querySelector('[role="alert"]') != null`);
    await browser("set", "offline", "off");
    expect(
      await evaluate<boolean>(
        `${card}?.querySelector('[data-question-option="owner"]')?.hasAttribute("data-selected") ?? false`,
      ),
    ).toBe(true);
    await shoot("phone-failed");
    // A slow send shows it is under way and takes no second press.
    await evaluate(`(() => {
      const send = window.fetch;
      window.fetch = (...args) => new Promise((resolve) => setTimeout(() => resolve(send(...args)), 1500));
      return true;
    })()`);
    await press("Submit");
    // Busy, it takes no presses (React Aria's pending state) until the answer is stored.
    await browser(
      "wait",
      "--fn",
      `${button("Submitting…")}?.hasAttribute("data-loading") === true`,
    );
    await shoot("phone-submitting");
    await browser("wait", "--fn", `${submit} == null && ${shown("webhook")}`);
    const stored = await db.actionCard.findUniqueOrThrow({ where: { messageId: message.id } });
    expect(stored.state).toBe("executed");
    const answers = (stored.result as { answers: { questionId: string; skipped?: true }[] })
      .answers;
    expect(answers.map((answer) => [answer.questionId, answer.skipped ?? false])).toEqual([
      ["webhook", false],
      ["agent", true],
      ["notify", false],
    ]);
    // Answered, the same pages as while answering: each pick marked, nothing to press but the
    // dots; the skipped question says so.
    expect(await evaluate<number>(`${card}.querySelectorAll("[data-question]").length`)).toBe(1);
    expect(await evaluate<boolean>(`${button("Back")} == null && ${button("Next")} == null`)).toBe(
      true,
    );
    expect(
      await evaluate<boolean>(
        `${card}?.querySelector('[data-question-option="keep"]')?.hasAttribute("data-selected") ?? false`,
      ),
    ).toBe(true);
    await shoot("phone-answered");
    await browser("click", `[data-message-id="${message.id}"] [aria-label="Question 2"]`);
    await browser("wait", "--fn", `${shown("agent")} && ${cardText}.includes("Not answered")`);
    await shoot("phone-answered-skipped");

    // Read again on a desktop: the stored answers, as anyone opening the channel later sees them.
    await browser("set", "viewport", "1280", "900");
    await browser("open", `${origin}/en/w/${workspace.slug}/channel/${channel.id}`);
    await browser("wait", "--fn", `${pageHydrated} && ${shown("webhook")}`);
    await evaluate(`(${card}.scrollIntoView({ block: "center" }), true)`);
    await shoot("answered");
    if (otherMessage) {
      const viewer = `document.querySelector('[data-message-id="${otherMessage.id}"] [data-questions-card]')`;
      await browser("wait", "--fn", `${viewer} != null`);
      // The same pages to look through, nothing to pick, and whom it waits on.
      expect(await evaluate<number>(`${viewer}.querySelectorAll("[data-question]").length`)).toBe(
        1,
      );
      expect(await evaluate<boolean>(`${viewer}.textContent.includes("Not answered")`)).toBe(false);
      expect(await evaluate<boolean>(`${viewer}.textContent.includes("Waiting for ")`)).toBe(true);
      expect(
        await evaluate<number>(`${viewer}.querySelectorAll('[aria-label^="Question "]').length`),
      ).toBe(3);
      await evaluate(`(${viewer}.scrollIntoView({ block: "center" }), true)`);
      await shoot("viewer");
      await browser("set", "viewport", "390", "844");
      await browser("wait", "--fn", `${viewer} != null`);
      await evaluate(`(${viewer}.scrollIntoView({ block: "center" }), true)`);
      await shoot("viewer-phone");
    }
  } finally {
    await browser("close").catch(() => undefined);
    await db.conversation.deleteMany({ where: { id: channel.id } }).catch(() => undefined);
    await db.agent.deleteMany({ where: { id: agent.id } }).catch(() => undefined);
    await db.$disconnect();
  }
}, 180_000);
