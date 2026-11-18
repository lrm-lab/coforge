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
} from "./helpers/question-card-e2e";

/**
 * A choice card's last row is the asked person's own answer (task #447), answered inside the card
 * in the stream: the row is itself an input ("Your own answer…"), Enter sends the words, and the
 * card keeps its height with the words in the row, the message below it not moving. A blank Enter
 * sends nothing. A click on an option of a choice card sends it at once; so does its number, or
 * Enter on the highlighted row (the first arrow key only shows the highlight). Alt+↓ and Alt+↑
 * walk the waiting cards from the keyboard, starting at the composer, which is never hidden.
 * Anyone but the asked person sees the options with no such row and nothing to tick; a card whose
 * Agent turned the row off has none either. Someone else's answer, a decline and an expiry each
 * read on the card when it is mounted later, compact.
 *
 * Opt-in like the other browser E2Es: real local Web + `agent-browser`. The channel, its Agent, a
 * second member and seven cards are seeded per run and removed after it. Screenshots (light, dark,
 * Chinese, a phone, answered, someone else's card) are written under `.artifacts/e2e/choice-card-other/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.artifacts/e2e/choice-card-other");

test("the asked person answers a choice card in its own last row", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `choice-other-${process.pid}`);
  const suffix = `${process.pid}-${Date.now()}`;
  const { workspaceId, workspace } = await devBrowserWorkspace(db);
  const seeded = await seedQuestionChannel(db, workspaceId, {
    peer: `e2e-other-peer-${suffix}`,
    agent: `e2e-other-agent-${suffix}`,
    agentDisplayName: "Asking Agent",
    channel: `e2e-other-${suffix}`,
  });
  const { peer, agent, channel, agentMember } = seeded;
  let sequence = 0;
  /** A choice card from the Agent, asking `to`, with its own-answer row unless `withOther` is
   * false (the Agent turned it off). */
  const ask = async (prompt: string, to: string, withOther = true) => {
    sequence += 1;
    return postCard(db, workspaceId, seeded, {
      sequence,
      body: `${prompt} (1. Red; 2. Blue)`,
      kind: "choice",
      payload: {
        type: "choice",
        prompt,
        options: [
          { id: "red", label: "Red" },
          { id: "blue", label: "Blue" },
        ],
        to,
        ...(withOther && { other: {} }),
      },
    });
  };
  const answered = await ask(`Which shade? ${suffix}`, DEV_BROWSER_USER.id);
  const others = await ask(`Which one, peer? ${suffix}`, peer.id);
  const keyed = await ask(`Which key? ${suffix}`, DEV_BROWSER_USER.id);
  const closed = await ask(`Red or blue only? ${suffix}`, DEV_BROWSER_USER.id, false);
  const clicked = await ask(`Which tone? ${suffix}`, DEV_BROWSER_USER.id);
  const shown = await ask(`Which colour? ${suffix}`, DEV_BROWSER_USER.id);
  // The message after the last card, so a card answered there has something below it to hold still.
  sequence += 1;
  const trailing = await db.message.create({
    data: {
      workspaceId,
      conversationId: channel.id,
      sequence,
      senderMemberId: agentMember.id,
      body: `The message under the cards ${suffix}`,
    },
  });
  await db.conversation.update({ where: { id: channel.id }, data: { lastSequence: sequence } });
  /** The message below each card, whose top must not move when the card is answered. */
  const below: Record<string, string> = {
    [answered]: others,
    [others]: keyed,
    [keyed]: closed,
    [closed]: clicked,
    [clicked]: shown,
    [shown]: trailing.id,
  };

  const card = (id: string) => `[data-message-id="${id}"] [data-question-card]`;
  const cardNode = (id: string) => `document.querySelector('${card(id)}')`;
  const optionSel = (id: string, option: string) =>
    `[data-message-id="${id}"] [data-question-option="${option}"]`;
  const input = (id: string) => `[data-message-id="${id}"] input[data-question-other-input]`;
  const cardText = (id: string) => `(${cardNode(id)}?.textContent ?? "")`;
  const stateIs = (id: string, state: string) =>
    `${cardNode(id)}?.dataset.questionCard === "${state}"`;
  const page = (locale: string) => `${origin}/${locale}/w/${workspace.slug}/channel/${channel.id}`;
  const top = (id: string) =>
    evaluate<number>(
      `document.querySelector('[data-message-id="${id}"]').getBoundingClientRect().top`,
    );
  const height = (id: string) => evaluate<number>(`${cardNode(id)}.getBoundingClientRect().height`);
  const optionTexts = (id: string) =>
    evaluate<string[]>(
      `[...${cardNode(id)}.querySelectorAll("[data-question-option]")].map((option) => [...option.childNodes].filter((node) => node.nodeName !== "KBD").map((node) => node.textContent).join("").trim())`,
    );
  const nothingTicked = (id: string) =>
    evaluate<boolean>(
      `[...${cardNode(id)}.querySelectorAll("[data-question-option]")].every((option) => option.getAttribute("aria-selected") !== "true")`,
    );
  const inComposer = IN_COMPOSER;
  const focusComposer = FOCUS_COMPOSER;
  /** The message id of the card whose options list holds the focus, or null. */
  const focusedCard = () =>
    evaluate<string | null>(
      `document.activeElement?.closest("[data-question-options]")?.closest("[data-message-id]")?.dataset.messageId ?? null`,
    );
  const open = async (locale = "en") => {
    await browser("open", page(locale));
    await browser("wait", "--fn", `${cardNode(shown)} !== null && ${pageHydrated}`);
  };
  /** Waits for the card to take its Answer view: a reload paints the conversation's stored copy
   * first and the server's read replaces it (cache-persistence/AGENTS.md), so a card the copy
   * holds as closed gets its options only once that read lands (task #109). */
  const waitingCard = (id: string) =>
    browser(
      "wait",
      "--fn",
      `${stateIs(id, "pending")} && ${cardNode(id)}.querySelector("[data-question-option]") !== null`,
    );
  const stateOf = async (id: string) =>
    (await db.actionCard.findUniqueOrThrow({ where: { messageId: id } })).state;
  /** Runs `act` and checks the card kept its height and the message below it did not move. */
  const settlesInPlace = async (id: string, act: () => Promise<void>) => {
    await evaluate(`(${cardNode(id)}.scrollIntoView({ block: "start" }), true)`);
    const [before, heightBefore] = [await top(below[id]!), await height(id)];
    await act();
    expect(await top(below[id]!)).toBe(before);
    expect(await height(id)).toBe(heightBefore);
  };
  /** Alt+↓ from the composer, then on, until the waiting card `id` has the focus. */
  const focusCard = async (id: string) => {
    await evaluate(focusComposer);
    for (let guard = 0; guard < 6; guard += 1) {
      await browser("press", "Alt+ArrowDown");
      await browser(
        "wait",
        "--fn",
        `document.activeElement?.closest("[data-question-options]") != null`,
      );
      if ((await focusedCard()) === id) return;
    }
    throw new Error(`Alt+ArrowDown never reached the card ${id}`);
  };
  try {
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1440", "900");
    await open();
    await waitingCard(shown);
    // Someone else's card waits on them by name, with the options and nothing to type in, send
    // or tick; a click on a row picks nothing.
    expect(await evaluate<string>(cardText(others))).toContain("Waiting on Asked Peer");
    expect(await optionTexts(others)).toEqual(["Red", "Blue"]);
    expect(
      await evaluate<boolean>(
        `${cardNode(others)}.querySelector("[data-question-other-input], [data-question-send], [data-question-decline]") === null`,
      ),
    ).toBe(true);
    await browser("click", optionSel(others, "red"));
    expect(await nothingTicked(others)).toBe(true);
    expect(await stateOf(others)).toBe("pending");

    // Without the own-words row, the asked person picks from the options alone.
    expect(
      await evaluate<boolean>(
        `${cardNode(closed)}.querySelector("[data-question-other]") === null`,
      ),
    ).toBe(true);
    expect(await optionTexts(closed)).toEqual(["Red", "Blue"]);
    expect(await stateOf(closed)).toBe("pending");

    // With it, the row after the options is an input named by its placeholder. The composer is
    // still there.
    expect(
      await evaluate<[string | null, string | null]>(
        `(() => { const el = document.querySelector('${input(shown)}'); return [el.getAttribute("aria-label"), el.getAttribute("placeholder")]; })()`,
      ),
    ).toEqual(["Your own answer…", "Your own answer…"]);
    expect(
      await evaluate<boolean>(
        `document.querySelector("[data-composer]").getClientRects().length > 0`,
      ),
    ).toBe(true);
    await evaluate(`(${cardNode(shown)}.scrollIntoView({ block: "center" }), true)`);
    await browser("screenshot", join(artifacts, "light.png"));

    // A blank Enter sends nothing.
    await browser("click", input(answered));
    await browser("press", "Enter");
    // Nothing is sent: no request fails (the server refuses a blank answer, and the card would say
    // so), the row is still there to type in, and the card still waits. Absence is only proved by
    // giving a send time to show up.
    await Bun.sleep(1_000);
    expect(
      await evaluate<boolean>(
        `${cardNode(answered)}.querySelector('[role="alert"]') === null && document.querySelector('${input(answered)}') !== null`,
      ),
    ).toBe(true);
    expect(await stateOf(answered)).toBe("pending");

    // The words show a Send; Enter in the row sends them. The card keeps its height with the words
    // in the row, and the message below does not move.
    await browser("fill", input(answered), "  Teal, but darker  ");
    await browser(
      "wait",
      "--fn",
      `${cardNode(answered)}.querySelector("[data-question-send]") !== null`,
    );
    await settlesInPlace(answered, async () => {
      await browser("press", "Enter");
      await browser("wait", "--fn", stateIs(answered, "executed"));
    });
    expect(await evaluate<string>(`${cardNode(answered)}.dataset.questionCardView`)).toBe("full");
    expect(await evaluate<boolean>(`${cardText(answered)}.includes("Teal, but darker")`)).toBe(
      true,
    );
    expect(
      await evaluate<boolean>(
        `${cardNode(answered)}.querySelector('[data-question-option="red"]').getAttribute("aria-selected") !== "true" && ${cardNode(answered)}.querySelector("[data-question-send]") === null`,
      ),
    ).toBe(true);
    const stored = await db.actionCard.findUniqueOrThrow({ where: { messageId: answered } });
    expect(stored.state).toBe("executed");
    expect(stored.result).toMatchObject({ optionId: "_other", text: "Teal, but darker" });
    await browser("screenshot", join(artifacts, "answered.png"));

    // From the keyboard, Alt+↓ walks the waiting cards from the composer (the peer's is not one
    // of them) and Alt+↑ goes back; the first arrow key only shows the highlight, a number picks
    // its option and a choice card sends it at once.
    const waiting = new Set([keyed, closed, clicked, shown]);
    await evaluate(focusComposer);
    expect(await evaluate<boolean>(inComposer)).toBe(true);
    await browser("press", "Alt+ArrowDown");
    await browser(
      "wait",
      "--fn",
      `document.activeElement?.closest("[data-question-options]") != null`,
    );
    const first = await focusedCard();
    expect(waiting.has(first!)).toBe(true);
    await browser("press", "Alt+ArrowDown");
    await browser(
      "wait",
      "--fn",
      `document.activeElement?.closest("[data-message-id]")?.dataset.messageId !== "${first}"`,
    );
    const second = await focusedCard();
    expect(waiting.has(second!)).toBe(true);
    await browser("press", "Alt+ArrowUp");
    await browser(
      "wait",
      "--fn",
      `document.activeElement?.closest("[data-message-id]")?.dataset.messageId === "${first}"`,
    );
    await focusCard(keyed);
    await browser("press", "ArrowDown");
    await browser(
      "wait",
      "--fn",
      `${cardNode(keyed)}.hasAttribute("data-question-keys") && ${cardNode(keyed)}.querySelector("[data-question-option][data-hi]") !== null`,
    );
    await browser("screenshot", join(artifacts, "keyboard.png"));
    await settlesInPlace(keyed, async () => {
      await browser("press", "2");
      await browser("wait", "--fn", stateIs(keyed, "executed"));
    });
    expect(
      (await db.actionCard.findUniqueOrThrow({ where: { messageId: keyed } })).result,
    ).toMatchObject({ optionId: "blue" });
    expect(
      await evaluate<boolean>(
        `${cardNode(keyed)}.querySelector('[data-question-option="blue"]').getAttribute("aria-selected") === "true" && ${cardNode(keyed)}.querySelector('[data-question-option="red"]').getAttribute("aria-selected") !== "true"`,
      ),
    ).toBe(true);
    await browser("screenshot", join(artifacts, "keyboard-picked.png"));

    // Enter takes the highlighted option and sends it, on a card without the own-words row.
    await focusCard(closed);
    await browser("press", "ArrowDown");
    await browser(
      "wait",
      "--fn",
      `${cardNode(closed)}.querySelector("[data-question-option][data-hi]") !== null`,
    );
    await browser("press", "ArrowDown");
    await browser(
      "wait",
      "--fn",
      `${cardNode(closed)}.querySelector("[data-question-option][data-hi]") !== null`,
    );
    const highlighted = await evaluate<string>(
      `${cardNode(closed)}.querySelector("[data-question-option][data-hi]").dataset.questionOption`,
    );
    await browser("press", "Enter");
    await browser("wait", "--fn", stateIs(closed, "executed"));
    expect(
      (await db.actionCard.findUniqueOrThrow({ where: { messageId: closed } })).result,
    ).toMatchObject({ optionId: highlighted });

    // A click on an option sends it at once, with no Send to press.
    await settlesInPlace(clicked, async () => {
      await browser("click", optionSel(clicked, "red"));
      await browser("wait", "--fn", stateIs(clicked, "executed"));
    });
    expect(
      (await db.actionCard.findUniqueOrThrow({ where: { messageId: clicked } })).result,
    ).toMatchObject({ optionId: "red" });

    // Someone else's answer sits beside its question, with who gave it by face and name, once the
    // card is mounted later (compact).
    await db.actionCard.update({
      where: { messageId: others },
      data: {
        state: "executed",
        committedByUserId: peer.id,
        committedAt: new Date(),
        result: { optionId: "red", label: "Red" },
      },
    });
    await open();
    await browser("wait", "--fn", stateIs(others, "executed"));
    expect(
      await evaluate<[string, string, string, boolean]>(`(() => {
        const el = ${cardNode(others)};
        return [
          el.dataset.questionCardView,
          el.querySelector('[data-question-answer="choice"]').textContent,
          el.querySelector("[data-question-status]").textContent,
          el.querySelector("[data-avatar]") !== null,
        ];
      })()`),
    ).toEqual([
      "compact",
      expect.stringContaining("Red"),
      expect.stringContaining("Asked Peer"),
      true,
    ]);
    expect(await evaluate<string>(cardText(others))).toContain(`Which one, peer? ${suffix}`);
    await browser("screenshot", join(artifacts, "answered-by-peer.png"));

    // A phone: the same card, the own-words row fits in it, every row is at least 44 px tall, and
    // the page does not scroll sideways. No sheet takes the card's place.
    await browser("set", "viewport", "390", "844");
    await open();
    await waitingCard(shown);
    expect(
      await evaluate<boolean>(
        `document.documentElement.scrollWidth <= document.documentElement.clientWidth`,
      ),
    ).toBe(true);
    await evaluate(`(${cardNode(shown)}.scrollIntoView({ block: "center" }), true)`);
    expect(
      await evaluate<boolean>(`(() => {
        const box = ${cardNode(shown)}.getBoundingClientRect();
        const own = document.querySelector('${input(shown)}').getBoundingClientRect();
        const rows = [...${cardNode(shown)}.querySelectorAll("[data-question-option]")];
        return own.left >= box.left && own.right <= box.right
          && rows.every((row) => row.getBoundingClientRect().height >= 44)
          && document.documentElement.scrollWidth <= document.documentElement.clientWidth;
      })()`),
    ).toBe(true);
    await browser("screenshot", join(artifacts, "phone.png"));
    await browser("set", "viewport", "1440", "900");

    // Closed without an answer, the card is gray and says why; declined by the person asked, it
    // names them (task #94).
    await db.actionCard.update({ where: { messageId: shown }, data: { state: "expired" } });
    await db.actionCard.update({
      where: { messageId: others },
      data: { state: "cancelled", result: undefined },
    });
    await browser("open", page("en"));
    await browser("wait", "--fn", pageHydrated);
    await browser("wait", "--fn", `${cardText(shown)}.includes("Expired")`);
    await browser("wait", "--fn", `${cardText(others)}.includes("Asked Peer didn't answer")`);
    expect(
      await evaluate<string[]>(
        `[${JSON.stringify(card(shown))}, ${JSON.stringify(card(others))}].map((selector) => document.querySelector(selector).dataset.questionCard)`,
      ),
    ).toEqual(["expired", "cancelled"]);
    await browser("screenshot", join(artifacts, "closed-by-peer.png"));
    // The rest of the run reads the first card waiting again.
    await db.actionCard.update({ where: { messageId: shown }, data: { state: "pending" } });

    await open("zh-CN");
    await waitingCard(shown);
    expect(
      await evaluate<string | null>(
        `document.querySelector('${input(shown)}').getAttribute("placeholder")`,
      ),
    ).toBe("自己写…");
    await evaluate(`(${cardNode(shown)}.scrollIntoView({ block: "center" }), true)`);
    await browser("screenshot", join(artifacts, "zh.png"));

    await evaluate(`document.documentElement.classList.add("dark-mode") ?? true`);
    await browser("wait", "300");
    await browser("screenshot", join(artifacts, "dark.png"));
    await evaluate(`document.documentElement.classList.remove("dark-mode") ?? true`);
  } finally {
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
