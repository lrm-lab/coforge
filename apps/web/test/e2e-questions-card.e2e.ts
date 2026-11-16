import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import {
  browserSession,
  devBrowserWorkspace,
  localBrowserE2e,
  pageHydrated,
} from "./helpers/browser-e2e";

/**
 * An Agent's several questions on one card (task #515): in the stream a summary of one line per
 * question, its own card and not another kind's ("Add members" on staging); answered in the dock
 * that takes the composer's place, one question per tab with the options to tick, the
 * recommendation marked and an own-answer row, and a review before sending. A question may be
 * skipped; a draft is kept in the browser and shown beside its question; offline the send fails
 * and keeps every answer; a slow send takes no second press; sent, the dock turns to its receipt
 * and the card shows each answer beside its question, a skipped one as Skipped. Someone else's
 * card names whom it waits on and opens a dock to look through, with nothing to pick.
 *
 * Opt-in like the other browser E2Es; the channel, Agent, a second member and the cards are seeded
 * per run and removed after it. Screenshots are written under `.amp/e2e/questions-card/`; the
 * phone's sheet is `e2e-questions-card-phone.e2e.ts`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/questions-card");

test("a questions card is answered in the dock, question by question, then sent at once", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate, waitFor } = browserSession(
    browserPath,
    `questions-card-${process.pid}`,
  );
  const { workspaceId, workspace } = await devBrowserWorkspace(db);
  const tail = `${process.pid}-${Date.now()}`.slice(-5);
  const peer = await db.user.create({
    data: { username: `e2e-questions-peer-${tail}`, displayName: "Asked Peer" },
  });
  await db.workspaceMembership.create({ data: { workspaceId, userId: peer.id } });
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
      members: {
        create: [{ userId: DEV_BROWSER_USER.id }, { userId: peer.id }, { agentId: agent.id }],
      },
    },
    include: { members: true },
  });
  const agentMember = channel.members.find((member) => member.agentId === agent.id)!;
  const payload = (to: string) => ({
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
  const ask = async (sequence: number, body: string, to: string) => {
    const message = await db.message.create({
      data: {
        workspaceId,
        conversationId: channel.id,
        sequence,
        senderMemberId: agentMember.id,
        body,
      },
    });
    await db.actionCard.create({
      data: {
        messageId: message.id,
        conversationId: channel.id,
        workspaceId,
        kind: "questions",
        payload: payload(to),
        preparedByAgentId: agent.id,
      },
    });
    return message.id;
  };
  // The viewer's card, and the same questions asked of someone else: the viewer only sees them,
  // and whom they wait on.
  const otherId = await ask(1, `And for someone else ${tail}`, peer.id);
  const messageId = await ask(
    2,
    `A few questions before sign-up goes live ${tail}`,
    DEV_BROWSER_USER.id,
  );
  await db.conversation.update({ where: { id: channel.id }, data: { lastSequence: 2 } });

  const card = (id: string) =>
    `document.querySelector('[data-message-id="${id}"] [data-question-card]')`;
  const cardText = `(${card(messageId)}?.textContent ?? "")`;
  const dock = "section[data-question-dock]";
  const page = "[data-dock-page-current]";
  const options = (index?: number) =>
    `${dock} ${page} [data-dock-list] > [role="option"]${index === undefined ? "" : `:nth-child(${index})`}`;
  const tab = (index: number) => `${dock} [data-dock-tab="${index}"]`;
  const onTab = (index: number) =>
    `document.querySelector('${tab(index)}')?.getAttribute("aria-current") === "step"`;
  const picked = (index: number) =>
    `document.querySelector('${options(index)}')?.getAttribute("aria-selected") === "true"`;
  const rowText = (id: string, question: string) =>
    `(document.querySelector('[data-message-id="${id}"] [data-question-row="${question}"]')?.textContent ?? "")`;
  const draftKey = `coforge.question-draft:${messageId}`;
  const shoot = async (name: string) => {
    await browser("wait", "300");
    await browser("screenshot", join(artifacts, `${name}.png`));
    await evaluate(`document.documentElement.classList.add("dark-mode") ?? true`);
    await browser("wait", "300");
    await browser("screenshot", join(artifacts, `${name}-dark.png`));
    await evaluate(`document.documentElement.classList.remove("dark-mode") ?? true`);
  };
  /** A press on the dock's Next, as a pointer makes it: the focus goes to the button. */
  const next = async () => {
    await evaluate(
      `([...document.querySelectorAll("${dock} button")].find((button) => button.textContent.trim() === "Next").setAttribute("data-e2e-next", ""), true)`,
    );
    await browser("click", "[data-e2e-next]");
    await evaluate(
      `(document.querySelector("[data-e2e-next]")?.removeAttribute("data-e2e-next"), true)`,
    );
  };
  const url = `${origin}/en/w/${workspace.slug}/channel/${channel.id}`;
  const load = async () => {
    await browser("open", url);
    await waitFor(
      `${card(messageId)}?.dataset.questionCard === "pending" && ${pageHydrated}`,
      60_000,
    );
  };
  const stored = () => db.actionCard.findUniqueOrThrow({ where: { messageId } });
  try {
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1280", "900");
    await load();
    // Its own card, never another kind's: one line to a question, nothing answered yet, and an
    // Answer for the viewer.
    expect(await evaluate<boolean>(`${cardText}.includes("Add members")`)).toBe(false);
    expect(
      await evaluate<string[]>(
        `[...${card(messageId)}.querySelectorAll("[data-question-row]")].map((row) => row.dataset.questionRow)`,
      ),
    ).toEqual(["webhook", "agent", "notify"]);
    expect(
      await evaluate<boolean>(
        `${card(messageId)}.querySelector("[data-question-card-answer]") !== null`,
      ),
    ).toBe(true);
    await evaluate(`(${card(messageId)}.scrollIntoView({ block: "center" }), true)`);
    const cardHeight = () =>
      evaluate<number>(`Math.round(${card(messageId)}.getBoundingClientRect().height)`);
    const askedHeight = await cardHeight();

    // Answer opens the dock at the first question: a tab for each and the review after them, the
    // recommendation marked, an option's description under it, and an own-answer row where the
    // Agent offers one.
    await browser("click", `[data-message-id="${messageId}"] [data-question-card-answer]`);
    await waitFor(
      `document.querySelector('${dock} [data-dock="answering"]') !== null && ${onTab(0)}`,
    );
    expect(
      await evaluate<string[]>(
        `[...document.querySelectorAll('${dock} [data-dock-tab]')].map((el) => el.textContent.trim())`,
      ),
    ).toEqual([
      "Set up the webhook so sign-ups get the Free tier at once?",
      "Which built-in Agent do new members get?",
      "Who hears about a new sign-up?",
      "Review",
    ]);
    expect(await evaluate<string>(`document.querySelector('${options(1)}').textContent`)).toContain(
      "Recommended",
    );
    expect(await evaluate<string>(`document.querySelector('${options(2)}').textContent`)).toContain(
      "Every sign-up, no review",
    );
    expect(
      await evaluate<number>(
        `document.querySelectorAll('${dock} ${page} [data-dock-other]').length`,
      ),
    ).toBe(1);
    await shoot("question-1");

    // A pick stays where it is (the way on is Next), is kept as a draft in the browser, and shows
    // beside its question in the stream, still gray.
    await browser("click", options(1));
    await waitFor(picked(1));
    await waitFor(`${rowText(messageId, "webhook")}.includes("Keep it manual")`);
    expect(await evaluate<boolean>(onTab(0))).toBe(true);
    expect(
      await evaluate<boolean>(`localStorage.getItem(${JSON.stringify(draftKey)}) !== null`),
    ).toBe(true);
    // Read again, the draft is still there.
    await load();
    await waitFor(`${rowText(messageId, "webhook")}.includes("Keep it manual")`);
    await browser("click", `[data-message-id="${messageId}"] [data-question-card-answer]`);
    await waitFor(
      `document.querySelector('${dock} [data-dock="answering"]') !== null && ${picked(1)}`,
    );

    // A question may be skipped: Next without an answer leaves it for the review to show.
    await next();
    await waitFor(onTab(1));
    await next();
    await waitFor(onTab(2));
    // Several picks wait: the keys tick them, and the last question's way on is the review.
    await browser("press", "1");
    await browser("press", "3");
    await waitFor(`${picked(1)} && ${picked(3)} && !(${picked(2)})`);
    expect(
      await evaluate<boolean>(`document.querySelector('${dock} [data-dock-submit]') === null`),
    ).toBe(true);
    await shoot("question-many");
    await next();
    await waitFor(onTab(3));
    // The review: each question with its answer, or Skipped; Send waits for an answer.
    const review = () =>
      evaluate<string[][]>(
        `[...document.querySelectorAll('${options()}')].map((row) => [...row.children].map((el) => el.textContent.trim()))`,
      );
    expect(await review()).toEqual([
      ["Set up the webhook so sign-ups get the Free tier at once?", "Keep it manual"],
      ["Which built-in Agent do new members get?", "Skipped"],
      ["Who hears about a new sign-up?", "Ops, Owner"],
    ]);
    expect(
      await evaluate<boolean>(
        `document.querySelector('${dock} [data-dock-submit]').disabled === false`,
      ),
    ).toBe(true);
    await shoot("review");

    // A row of the review goes back to its question; its own words are an answer, and taken back
    // the question is skipped after all.
    await browser("click", options(2));
    await waitFor(onTab(1));
    await browser("fill", `${dock} ${page} [data-dock-other]`, "Ask me each time");
    await shoot("question-other");
    await browser("click", tab(3));
    await waitFor(onTab(3));
    expect((await review())[1]).toEqual([
      "Which built-in Agent do new members get?",
      "Ask me each time",
    ]);
    await browser("click", tab(1));
    await waitFor(onTab(1));
    await browser("click", `${dock} ${page} [data-dock-other]`);
    await browser("press", "End");
    for (const _ of "Ask me each time") await browser("press", "Backspace");
    await browser("click", tab(3));
    await waitFor(onTab(3));
    expect((await review())[1]).toEqual(["Which built-in Agent do new members get?", "Skipped"]);

    // Offline, the send fails: the dock says so and keeps every answer for another try.
    await browser("set", "offline", "on");
    await browser("click", `${dock} [data-dock-submit]`);
    await waitFor(`document.querySelector('${dock} [role="alert"]') !== null`);
    await browser("set", "offline", "off");
    expect(
      await evaluate<string>(`document.querySelector('${dock} [role="alert"]').textContent`),
    ).toBe("Didn't send. Try again.");
    expect(
      await evaluate<boolean>(`document.querySelector('${dock} [data-dock="answering"]') !== null`),
    ).toBe(true);
    expect((await review())[2]).toEqual(["Who hears about a new sign-up?", "Ops, Owner"]);
    expect((await stored()).state).toBe("pending");
    await shoot("failed");
    // A slow send shows it is under way and takes no second press.
    await evaluate(`(() => {
      const send = window.fetch;
      window.fetch = (...args) => new Promise((resolve) => setTimeout(() => resolve(send(...args)), 1500));
      return true;
    })()`);
    await browser("click", `${dock} [data-dock-submit]`);
    await waitFor(
      `document.querySelector('${dock} [data-dock-submit]')?.textContent.trim() === "Sending…" && document.querySelector('${dock} [data-dock-submit]').hasAttribute("data-loading")`,
    );
    await shoot("submitting");
    await waitFor(`document.querySelector('${dock} [data-dock-receipt]') !== null`);
    const sent = await stored();
    expect(sent.state).toBe("executed");
    const answers = (sent.result as { answers: { questionId: string; skipped?: true }[] }).answers;
    expect(answers.map((answer) => [answer.questionId, answer.skipped ?? false])).toEqual([
      ["webhook", false],
      ["agent", true],
      ["notify", false],
    ]);
    // The draft goes with the send.
    expect(
      await evaluate<boolean>(`localStorage.getItem(${JSON.stringify(draftKey)}) === null`),
    ).toBe(true);

    // The receipt says each answer, the skipped one as such; the card in the stream shows them
    // beside their questions.
    const receiptRows = await evaluate<string[][]>(
      `[...document.querySelectorAll('${dock} [data-dock-receipt] [class*="min-h-9"]')].map((row) => [...row.children].map((el) => el.textContent.trim()))`,
    );
    expect(receiptRows).toEqual([
      ["Set up the webhook so sign-ups get the Free tier at once?", "Keep it manual"],
      ["Which built-in Agent do new members get?", "Skipped"],
      ["Who hears about a new sign-up?", "Ops, Owner"],
    ]);
    await waitFor(`${card(messageId)}?.dataset.questionCard === "executed"`);
    // Answered while on screen, the card keeps its height though its Answer line is gone, so the
    // stream below it does not move (Frank, 11-16).
    expect(await cardHeight()).toBe(askedHeight);
    expect(await evaluate<string>(rowText(messageId, "webhook"))).toContain("Keep it manual");
    expect(await evaluate<string>(rowText(messageId, "agent"))).toContain("Skipped");
    expect(await evaluate<string>(rowText(messageId, "notify"))).toContain("Ops, Owner");
    expect(
      await evaluate<boolean>(
        `${card(messageId)}.querySelector("[data-question-card-answer]") === null`,
      ),
    ).toBe(true);
    // Nothing left to press on the answered card: its rows are not buttons that open anything.
    expect(
      await evaluate<boolean>(
        `[...${card(messageId)}.querySelectorAll("[data-question-row]")].every((row) => row.disabled)`,
      ),
    ).toBe(true);
    await shoot("receipt");
    await browser("press", "Escape");
    await waitFor(`document.querySelector('${dock}') === null`);

    // Read again: the stored answers, as anyone opening the channel later sees them.
    await browser("open", url);
    await waitFor(
      `${card(messageId)}?.dataset.questionCard === "executed" && ${pageHydrated}`,
      60_000,
    );
    expect(await evaluate<string>(rowText(messageId, "notify"))).toContain("Ops, Owner");
    expect(await cardHeight()).toBeLessThan(askedHeight);

    // Someone else's card names whom it waits on, with no Answer; a row opens a dock to look
    // through: the same questions as tabs and no review, nothing to pick, type, send or decline.
    expect(await evaluate<string>(`${card(otherId)}.textContent`)).toContain(
      "Waiting on Asked Peer",
    );
    expect(
      await evaluate<boolean>(
        `${card(otherId)}.querySelector("[data-question-card-answer]") === null`,
      ),
    ).toBe(true);
    await evaluate(`(${card(otherId)}.scrollIntoView({ block: "center" }), true)`);
    await browser("click", `[data-message-id="${otherId}"] [data-question-row="agent"]`);
    await waitFor(
      `document.querySelector('${dock} [data-dock="viewing"]') !== null && ${onTab(1)}`,
    );
    expect(
      await evaluate<number>(`document.querySelectorAll('${dock} [data-dock-tab]').length`),
    ).toBe(3);
    expect(
      await evaluate<boolean>(
        `["[data-dock-submit]", "[data-dock-other]", "[data-dock-decline]"].every((selector) => document.querySelector('${dock} ' + selector) === null)`,
      ),
    ).toBe(true);
    // ← → turn the questions again and again, and back.
    await browser("press", "ArrowRight");
    await waitFor(onTab(2));
    await browser("press", "ArrowLeft");
    await waitFor(onTab(1));
    await browser("press", "ArrowLeft");
    await waitFor(onTab(0));
    await browser("press", "ArrowRight");
    await waitFor(onTab(1));
    await browser("click", options(2));
    expect(
      await evaluate<boolean>(
        `[...document.querySelectorAll('${dock} [role="option"]')].every((option) => option.getAttribute("aria-selected") === "false")`,
      ),
    ).toBe(true);
    await shoot("viewer");
    await browser("press", "Escape");
    await waitFor(`document.querySelector('${dock}') === null`);
    expect((await db.actionCard.findUniqueOrThrow({ where: { messageId: otherId } })).state).toBe(
      "pending",
    );
  } finally {
    await browser("eval", `localStorage.removeItem(${JSON.stringify(draftKey)})`).catch(
      () => undefined,
    );
    await browser("close").catch(() => undefined);
    await db.conversation.deleteMany({ where: { id: channel.id } }).catch(() => undefined);
    await db.agent.deleteMany({ where: { id: agent.id } }).catch(() => undefined);
    await db.workspaceMembership
      .deleteMany({ where: { workspaceId, userId: peer.id } })
      .catch(() => undefined);
    await db.user.deleteMany({ where: { id: peer.id } }).catch(() => undefined);
    await db.$disconnect();
  }
}, 180_000);
