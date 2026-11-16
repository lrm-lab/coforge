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
import {
  FOCUS_COMPOSER,
  IN_COMPOSER,
  postCard,
  seedQuestionChannel,
  signUpQuestions,
} from "./helpers/question-card-e2e";

/**
 * An Agent's several questions on one card (task #515), answered where it stands in the stream: a
 * stepper that shows one question at a time with its options to tick, the recommendation marked,
 * an own-answer row, a pager (`1 / 3`) and a Skip that turns to Next once the question has an
 * answer; the last question ends in Send, which waits for an answer. A pick on a single-pick
 * question turns to the next one by itself; a many-pick one is ticked and left. The keyboard
 * works the card (Alt+↓ from the composer, ↑ ↓ highlight, a digit picks, Space ticks, Enter goes
 * on, ← → turn, Esc back to the composer). A question may be skipped; a draft is kept in the
 * browser and shown again after a reload; offline the send fails and keeps every answer; a slow
 * send disables Send. Sent, the card turns into a summary in place at the height it had, so the
 * message after it does not move, each answer beside its question and a skipped one as Skipped;
 * read again later it is compact. Someone else's card names whom it waits on, shows its options
 * with nothing ticked, and its pager still turns. The composer is never hidden.
 *
 * Opt-in like the other browser E2Es; the channel, Agent, a second member and the cards are seeded
 * per run and removed after it. Screenshots are written under `.amp/e2e/questions-card/`; the
 * phone is `e2e-questions-card-phone.e2e.ts`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/questions-card");

test("a questions card is answered in the stream, question by question, then sent at once", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate, waitFor } = browserSession(
    browserPath,
    `questions-card-${process.pid}`,
  );
  const { workspaceId, workspace } = await devBrowserWorkspace(db);
  const tail = `${process.pid}-${Date.now()}`.slice(-5);
  const seeded = await seedQuestionChannel(db, workspaceId, {
    peer: `e2e-questions-peer-${tail}`,
    agent: `e2e-questions-${tail}`,
    agentDisplayName: `Questions Agent ${tail}`,
    channel: `e2e-questions-${tail}`,
  });
  const { peer, agent, channel, agentMember } = seeded;
  const ask = (sequence: number, body: string, to: string) =>
    postCard(db, workspaceId, seeded, {
      sequence,
      body,
      kind: "questions",
      payload: signUpQuestions(tail, to),
    });
  // The viewer's card, and the same questions asked of someone else: the viewer only sees them,
  // and whom they wait on.
  const otherId = await ask(1, `And for someone else ${tail}`, peer.id);
  const messageId = await ask(
    2,
    `A few questions before sign-up goes live ${tail}`,
    DEV_BROWSER_USER.id,
  );

  const after = await db.message.create({
    data: {
      workspaceId,
      conversationId: channel.id,
      sequence: 3,
      senderMemberId: agentMember.id,
      body: `After the questions ${tail}`,
    },
  });
  const afterId = after.id;
  await db.conversation.update({ where: { id: channel.id }, data: { lastSequence: 3 } });

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
  const inComposer = IN_COMPOSER;
  const focusComposer = FOCUS_COMPOSER;
  const rows = (id: string) =>
    evaluate<string[]>(
      `[...${card(id)}.querySelectorAll("[data-question-answer]")].map((row) => row.dataset.questionAnswer)`,
    );
  const answerRow = (id: string, question: string) =>
    `(${card(id)}.querySelector('[data-question-answer="${question}"]')?.textContent ?? "")`;
  /** The card's height and where the message after it starts, which must not change on answering. */
  const settled = () =>
    evaluate<{ height: number; below: number }>(
      `({ height: ${card(messageId)}.getBoundingClientRect().height, below: document.querySelector('[data-message-id="${afterId}"]').getBoundingClientRect().top })`,
    );
  const shoot = async (name: string) => {
    await browser("wait", "300");
    await browser("screenshot", join(artifacts, `${name}.png`));
    await evaluate(`document.documentElement.classList.add("dark-mode") ?? true`);
    await browser("wait", "300");
    await browser("screenshot", join(artifacts, `${name}-dark.png`));
    await evaluate(`document.documentElement.classList.remove("dark-mode") ?? true`);
  };
  /** Turns the pager of `id` until it stands at question `index`. */
  const goTo = async (index: number, id = messageId) => {
    for (let guard = 0; guard < 4; guard += 1) {
      const current = Number(await evaluate<string>(`${card(id)}.dataset.questionAt`));
      if (current === index) return;
      const step = current < index ? 1 : -1;
      await browser(
        "click",
        scoped(id, `button[data-question-page="${step > 0 ? "next" : "prev"}"]`),
      );
      await waitFor(onQuestion(current + step, id));
    }
    throw new Error(`the pager never reached question ${index}`);
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
    // Its own card, never another kind's: its own title, the first question with the
    // recommendation marked and an option's description under it, an own-answer row, and a pager.
    // Nothing takes the composer's place, and no Answer button sits on the card.
    expect(await evaluate<boolean>(`${cardText}.includes("Add members")`)).toBe(false);
    expect(await evaluate<string>(`${card(messageId)}.dataset.questionCardView`)).toBe("full");
    expect(
      await evaluate<string>(
        `${card(messageId)}.querySelector("[data-question-title]").textContent`,
      ),
    ).toBe(`Sign-up automation ${tail}`);
    expect(
      await evaluate<string>(
        `${card(messageId)}.querySelector("[data-question-prompt]").textContent`,
      ),
    ).toBe("Set up the webhook so sign-ups get the Free tier at once?");
    expect(await evaluate<string>(`${card(messageId)}.dataset.questionAt`)).toBe("0");
    expect(
      await evaluate<string>(
        `${card(messageId)}.querySelector("[data-question-pager]").textContent`,
      ),
    ).toContain("1 / 3");
    expect(
      await evaluate<string[]>(
        `[...${card(messageId)}.querySelectorAll("[data-question-option]")].map((row) => row.dataset.questionOption)`,
      ),
    ).toEqual(["keep", "auto"]);
    expect(
      await evaluate<string>(
        `document.querySelector('${scoped(messageId, '[data-question-option="keep"]')}').textContent`,
      ),
    ).toContain("Recommended");
    expect(
      await evaluate<string>(
        `document.querySelector('${scoped(messageId, '[data-question-option="auto"]')}').textContent`,
      ),
    ).toContain("Every sign-up, no review");
    expect(
      await evaluate<number>(`${card(messageId)}.querySelectorAll("[data-question-other]").length`),
    ).toBe(1);
    expect(await evaluate<string>(nextLabel)).toBe("Skip");
    expect(
      await evaluate<boolean>(
        `document.querySelector("[data-composer]").getClientRects().length > 0`,
      ),
    ).toBe(true);
    await evaluate(`(${card(messageId)}.scrollIntoView({ block: "center" }), true)`);
    await shoot("question-1");

    // The keyboard, from the composer: Alt+↓ puts the focus on the card's options; the first ↓
    // only shows the highlight (and marks the card as keyed), the next moves it; Enter takes the
    // highlighted option and goes on to the next question.
    await evaluate(focusComposer);
    expect(await evaluate<boolean>(inComposer)).toBe(true);
    await browser("press", "Alt+ArrowDown");
    await waitFor(listFocused());
    await browser("press", "ArrowDown");
    await waitFor(`${card(messageId)}.hasAttribute("data-question-keys")`);
    const shown = await highlighted();
    expect(shown).not.toBeNull();
    await browser("press", "ArrowDown");
    await waitFor(
      `${card(messageId)}.querySelector("[data-question-option][data-hi]")?.dataset.questionOption !== ${JSON.stringify(shown)}`,
    );
    await highlightTo("keep");
    await browser("press", "Enter");
    await waitFor(onQuestion(1));
    // The pick is kept as a draft in the browser.
    expect(
      await evaluate<boolean>(`localStorage.getItem(${JSON.stringify(draftKey)}) !== null`),
    ).toBe(true);

    // A question may be skipped: its own words are an answer (Skip turns to Next), and taken back
    // the question is skipped after all.
    expect(await evaluate<string>(nextLabel)).toBe("Skip");
    await browser(
      "fill",
      scoped(messageId, "input[data-question-other-input]"),
      "Ask me each time",
    );
    await waitFor(`${nextLabel} === "Next"`);
    await shoot("question-other");
    // Taken back key by key, as a person would: a fill with nothing types nothing.
    await browser("press", "End");
    for (const _ of "Ask me each time") await browser("press", "Backspace");
    await waitFor(`${nextLabel} === "Skip"`);
    await browser("click", nextButton);
    await waitFor(onQuestion(2));

    // The last question picks several, and ends in Send instead of Skip or Next. A click ticks, a
    // digit ticks that row, Space ticks the highlighted one (and unticks it); nothing turns.
    await browser("click", scoped(messageId, '[data-question-option="ops"]'));
    await waitFor(picked("ops"));
    await browser("press", "3");
    await waitFor(`${picked("ops")} && ${picked("owner")} && !(${picked("sales")})`);
    await highlightTo("sales");
    await browser("press", "Space");
    await waitFor(picked("sales"));
    await browser("press", "Space");
    await waitFor(`!(${picked("sales")})`);
    expect(await evaluate<boolean>(onQuestion(2))).toBe(true);
    expect(
      await evaluate<boolean>(
        `document.querySelector('${nextButton}') === null && document.querySelector('${send}') !== null`,
      ),
    ).toBe(true);
    await shoot("question-many");
    // Esc leaves the card for the composer, and Alt+↓ comes back; ← → turn the questions.
    await browser("press", "Escape");
    await waitFor(inComposer);
    expect((await stored()).state).toBe("pending");
    await browser("press", "Alt+ArrowDown");
    await waitFor(listFocused());
    await browser("press", "ArrowLeft");
    await waitFor(onQuestion(1));
    expect(await evaluate<string>(nextLabel)).toBe("Skip");
    await browser("press", "ArrowRight");
    await waitFor(onQuestion(2));
    await browser("press", "ArrowLeft");
    await waitFor(onQuestion(1));
    await browser("press", "ArrowRight");
    await waitFor(onQuestion(2));
    // The pager turns the same way.
    await goTo(0);
    expect(
      await evaluate<string>(
        `${card(messageId)}.querySelector("[data-question-pager]").textContent`,
      ),
    ).toContain("1 / 3");
    await waitFor(picked("keep"));
    await goTo(2);

    // Offline, the send fails: the card says so and keeps every answer for another try.
    await browser("set", "offline", "on");
    await browser("click", send);
    await waitFor(`${card(messageId)}.querySelector('[role="alert"]') !== null`);
    await browser("set", "offline", "off");
    expect(
      await evaluate<string>(`${card(messageId)}.querySelector('[role="alert"]').textContent`),
    ).toBe("Didn't send. Try again.");
    await waitFor(`${picked("ops")} && ${picked("owner")}`);
    expect((await stored()).state).toBe("pending");
    await shoot("failed");

    // Read again, the drafts are still there: the first question's pick and the last one's ticks.
    await load();
    await goTo(0);
    await waitFor(picked("keep"));
    await goTo(2);
    await waitFor(`${picked("ops")} && ${picked("owner")} && !(${picked("sales")})`);
    await evaluate(`(${card(messageId)}.scrollIntoView({ block: "center" }), true)`);
    const asked = await settled();

    // A slow send shows it is under way and takes no second press.
    await evaluate(`(() => {
      const send = window.fetch;
      window.fetch = (...args) => new Promise((resolve) => setTimeout(() => resolve(send(...args)), 1500));
      return true;
    })()`);
    await browser("click", send);
    await waitFor(
      `(() => { const button = document.querySelector('${send}'); return button !== null && (button.disabled || button.getAttribute("aria-disabled") === "true" || button.hasAttribute("data-loading")); })()`,
    );
    await shoot("submitting");
    await waitFor(`${card(messageId)}?.dataset.questionCard === "executed"`);
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

    // Answered while on screen, the card settles where it stands: its height and the message
    // below it do not move, the page it was sent from stays with its picks marked and the rest
    // muted, the pager still turns through the answers (the skipped one has nothing marked), and
    // the footer says when. The composer was never hidden.
    expect(await evaluate<string>(`${card(messageId)}.dataset.questionCardView`)).toBe("full");
    expect(await settled()).toEqual(asked);
    const chosen = () =>
      evaluate<string[]>(
        `[...${card(messageId)}.querySelectorAll("[data-question-option][data-chosen]")].map((row) => row.dataset.questionOption)`,
      );
    const pager = () =>
      evaluate<string>(`${card(messageId)}.querySelector("[data-question-pager]").textContent`);
    expect(await pager()).toContain("3 / 3");
    expect(await chosen()).toEqual(["ops", "owner"]);
    await browser("click", scoped(messageId, 'button[data-question-page="prev"]'));
    await waitFor(
      `${card(messageId)}.querySelector("[data-question-pager]").textContent.includes("2 / 3")`,
    );
    expect(await chosen()).toEqual([]);
    await browser("click", scoped(messageId, 'button[data-question-page="prev"]'));
    await waitFor(
      `${card(messageId)}.querySelector("[data-question-pager]").textContent.includes("1 / 3")`,
    );
    expect(await chosen()).toEqual(["keep"]);
    expect(await settled()).toEqual(asked);
    expect(
      await evaluate<boolean>(
        `${card(messageId)}.querySelector("[data-question-status]")?.textContent.trim() !== "" && ${card(messageId)}.querySelector("[data-question-send], [data-question-decline], [data-question-next]") === null && document.querySelector("[data-composer]").getClientRects().length > 0`,
      ),
    ).toBe(true);
    await shoot("answered");

    // Read again: the stored answers, compact, as anyone opening the channel later sees them.
    await browser("open", url);
    await waitFor(
      `${card(messageId)}?.dataset.questionCard === "executed" && ${pageHydrated}`,
      60_000,
    );
    expect(await evaluate<string>(`${card(messageId)}.dataset.questionCardView`)).toBe("compact");
    expect(await rows(messageId)).toEqual(["webhook", "agent", "notify"]);
    expect(await evaluate<string>(answerRow(messageId, "webhook"))).toContain(
      "Set up the webhook so sign-ups get the Free tier at once?",
    );
    expect(await evaluate<string>(answerRow(messageId, "webhook"))).toContain("Keep it manual");
    expect(await evaluate<string>(answerRow(messageId, "agent"))).toContain("Skipped");
    expect(await evaluate<string>(answerRow(messageId, "notify"))).toContain("Ops, Owner");
    await shoot("compact");

    // Someone else's card names whom it waits on and offers nothing to answer with: the same
    // options, nothing ticked, no way to type, send or decline, and a click picks nothing; the
    // pager still turns through its questions.
    expect(await evaluate<string>(`${card(otherId)}.textContent`)).toContain(
      "Waiting on Asked Peer",
    );
    expect(await evaluate<string>(`${card(otherId)}.dataset.questionCardView`)).toBe("full");
    expect(
      await evaluate<boolean>(
        `${card(otherId)}.querySelector("[data-question-send], [data-question-next], [data-question-other-input], [data-question-decline]") === null`,
      ),
    ).toBe(true);
    await evaluate(`(${card(otherId)}.scrollIntoView({ block: "center" }), true)`);
    await goTo(1, otherId);
    await browser("click", scoped(otherId, '[data-question-option="helper"]'));
    expect(
      await evaluate<boolean>(
        `[...${card(otherId)}.querySelectorAll("[data-question-option]")].every((option) => option.getAttribute("aria-selected") !== "true")`,
      ),
    ).toBe(true);
    await goTo(2, otherId);
    await goTo(0, otherId);
    await shoot("viewer");
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
