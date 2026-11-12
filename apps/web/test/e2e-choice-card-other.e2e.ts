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
 * A choice card's last row is the asked person's own answer (task #447): in the dock the row is
 * itself an input ("Your own answer…"), Enter sends the words, and the card closes to one line, the
 * question with the words beside it (task #449). A blank Enter sends nothing. Anyone but the asked
 * person looks through the options in a dock with no such row; a card whose Agent turned the row
 * off has none either. An option's number picks it from the keyboard, Enter sends it, and the
 * receipt offers the next card waiting on the viewer. Someone else's answer, a decline and an
 * expiry each read on the stream card.
 *
 * Opt-in like the other browser E2Es: real local Web + `agent-browser`. The channel, its Agent, a
 * second member and five cards are seeded per run and removed after it. Screenshots (light, dark,
 * Chinese, a phone, answered, someone else's card) are written under `.amp/e2e/choice-card-other/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/choice-card-other");

test("the asked person answers a choice card in its own last row", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `choice-other-${process.pid}`);
  const suffix = `${process.pid}-${Date.now()}`;
  const { workspaceId, workspace } = await devBrowserWorkspace(db);
  const peer = await db.user.create({
    data: { username: `e2e-other-peer-${suffix}`, displayName: "Asked Peer" },
  });
  await db.workspaceMembership.create({ data: { workspaceId, userId: peer.id } });
  const agent = await db.agent.create({
    data: {
      workspaceId,
      name: `e2e-other-agent-${suffix}`,
      displayName: "Asking Agent",
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
      channelName: `e2e-other-${suffix}`,
      description: "",
      members: {
        create: [{ userId: DEV_BROWSER_USER.id }, { userId: peer.id }, { agentId: agent.id }],
      },
    },
    include: { members: true },
  });
  const agentMember = channel.members.find((member) => member.agentId === agent.id)!;
  let sequence = 0;
  /** A choice card from the Agent, asking `to`, with its own-answer row unless `withOther` is
   * false (the Agent turned it off). */
  const ask = async (prompt: string, to: string, withOther = true) => {
    sequence += 1;
    const message = await db.message.create({
      data: {
        workspaceId,
        conversationId: channel.id,
        sequence,
        senderMemberId: agentMember.id,
        body: `${prompt} (1. Red; 2. Blue)`,
      },
    });
    await db.actionCard.create({
      data: {
        messageId: message.id,
        conversationId: channel.id,
        workspaceId,
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
        preparedByAgentId: agent.id,
      },
    });
    return message.id;
  };
  const answered = await ask(`Which shade? ${suffix}`, DEV_BROWSER_USER.id);
  const others = await ask(`Which one, peer? ${suffix}`, peer.id);
  const keyed = await ask(`Which key? ${suffix}`, DEV_BROWSER_USER.id);
  const closed = await ask(`Red or blue only? ${suffix}`, DEV_BROWSER_USER.id, false);
  // The latest, so a phone's stream still has it on screen.
  const shown = await ask(`Which colour? ${suffix}`, DEV_BROWSER_USER.id);
  await db.conversation.update({ where: { id: channel.id }, data: { lastSequence: sequence } });

  const card = (id: string) => `[data-message-id="${id}"] [data-question-card]`;
  const row = (id: string) => `[data-message-id="${id}"] [data-question-row="choice"]`;
  const dock = "[data-question-dock]";
  const input = `${dock} [data-dock-other]`;
  const cardText = (id: string) => `(document.querySelector('${card(id)}')?.textContent ?? "")`;
  const page = (locale: string) => `${origin}/${locale}/w/${workspace.slug}/channel/${channel.id}`;
  /** The card the dock is on: its options' ids start with the message's. */
  const dockOn = (id: string) =>
    `document.querySelector('${dock} [data-dock-page-current] [role="option"]')?.id.startsWith("${id}") === true`;
  const open = async (locale = "en") => {
    await browser("open", page(locale));
    await browser(
      "wait",
      "--fn",
      `document.querySelector('${card(shown)}') !== null && ${pageHydrated}`,
    );
  };
  const openDock = async (id: string) => {
    await browser("click", `[data-message-id="${id}"] [data-question-card-answer]`);
    await browser(
      "wait",
      "--fn",
      `document.querySelector('${dock} [data-dock="answering"]') !== null && ${dockOn(id)}`,
    );
  };
  const stateOf = async (id: string) =>
    (await db.actionCard.findUniqueOrThrow({ where: { messageId: id } })).state;
  try {
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1440", "900");
    await open();
    // Someone else's card waits on them by name, with no Answer to press; its row opens a dock to
    // look through, with the options and nothing to type in or send.
    expect(await evaluate<string>(cardText(others))).toContain("Waiting on Asked Peer");
    expect(
      await evaluate<boolean>(
        `document.querySelector('${card(others)} [data-question-card-answer]') === null`,
      ),
    ).toBe(true);
    await browser("click", row(others));
    await browser(
      "wait",
      "--fn",
      `document.querySelector('${dock} [data-dock="viewing"]') !== null`,
    );
    expect(
      await evaluate<string[]>(
        `[...document.querySelectorAll('${dock} [data-dock-page-current] [role="option"]')].map((option) => option.textContent.trim())`,
      ),
    ).toEqual(["Red", "Blue"]);
    expect(
      await evaluate<boolean>(
        `document.querySelector('${input}') === null && document.querySelector('${dock} [data-dock-submit]') === null`,
      ),
    ).toBe(true);
    await browser("press", "Escape");
    await browser("wait", "--fn", `document.querySelector('${dock}') === null`);

    // Without the own-words row, the asked person picks from the options alone, and the card waits.
    await openDock(closed);
    expect(await evaluate<boolean>(`document.querySelector('${input}') === null`)).toBe(true);
    expect(
      await evaluate<number>(
        `document.querySelectorAll('${dock} [data-dock-page-current] [role="option"]').length`,
      ),
    ).toBe(2);
    await browser("press", "Escape");
    await browser("wait", "--fn", `document.querySelector('${dock}') === null`);
    expect(await stateOf(closed)).toBe("pending");

    // With it, the row after the options is an input named by its placeholder.
    await openDock(shown);
    expect(
      await evaluate<[string | null, string | null]>(
        `(() => { const el = document.querySelector('${input}'); return [el.getAttribute("aria-label"), el.getAttribute("placeholder")]; })()`,
      ),
    ).toEqual(["Your own answer…", "Your own answer…"]);
    await browser("screenshot", join(artifacts, "light.png"));
    await browser("press", "Escape");
    await browser("wait", "--fn", `document.querySelector('${dock}') === null`);

    // A blank Enter sends nothing.
    await openDock(answered);
    await browser("click", input);
    await browser("press", "Enter");
    // Nothing is sent: no request fails (the server refuses a blank answer, and the dock would say
    // so), the row is still there to type in, and the card still waits.
    await Bun.sleep(1_000);
    expect(
      await evaluate<boolean>(
        `document.querySelector('${dock} [role="alert"]') === null && document.querySelector('${input}') !== null`,
      ),
    ).toBe(true);
    expect(await stateOf(answered)).toBe("pending");

    // The words, then Enter: the dock turns to its receipt, and the card closes to the question
    // with the words beside it.
    await browser("fill", input, "  Teal, but darker  ");
    await browser("press", "Enter");
    await browser("wait", "--fn", `document.querySelector('${dock} [data-dock-receipt]') !== null`);
    await browser(
      "wait",
      "--fn",
      `document.querySelector('${card(answered)}')?.dataset.questionCard === "executed" && ${cardText(answered)}.includes("Teal, but darker")`,
    );
    expect(await evaluate<boolean>(`${cardText(answered)}.includes("Red")`)).toBe(false);
    expect(
      await evaluate<boolean>(
        `document.querySelector('${dock} [data-dock-receipt]').textContent.includes("Teal, but darker")`,
      ),
    ).toBe(true);
    const stored = await db.actionCard.findUniqueOrThrow({ where: { messageId: answered } });
    expect(stored.state).toBe("executed");
    expect(stored.result).toMatchObject({ optionId: "_other", text: "Teal, but darker" });
    await browser("screenshot", join(artifacts, "answered.png"));

    // From the keyboard: Enter on the receipt goes on to the next card waiting on the viewer (the
    // peer's is skipped); a number picks its option and Enter sends it.
    await browser("press", "Enter");
    await browser(
      "wait",
      "--fn",
      `document.querySelector('${dock} [data-dock="answering"]') !== null && ${dockOn(keyed)}`,
    );
    await browser("press", "2");
    await browser(
      "wait",
      "--fn",
      `document.querySelector('${dock} [data-dock-page-current] [role="option"][aria-selected="true"]')?.textContent.startsWith("Blue") === true`,
    );
    await browser("screenshot", join(artifacts, "keyboard.png"));
    await browser("press", "Enter");
    await browser("wait", "--fn", `document.querySelector('${dock} [data-dock-receipt]') !== null`);
    expect(
      (await db.actionCard.findUniqueOrThrow({ where: { messageId: keyed } })).result,
    ).toMatchObject({
      optionId: "blue",
    });
    await browser("wait", "--fn", `${cardText(keyed)}.includes("Blue")`);
    await browser("screenshot", join(artifacts, "keyboard-picked.png"));

    // The receipt's next card is the one left below it, picked with the pointer and sent.
    await browser("press", "Enter");
    await browser(
      "wait",
      "--fn",
      `document.querySelector('${dock} [data-dock="answering"]') !== null && ${dockOn(closed)}`,
    );
    await browser("click", `${dock} [data-dock-page-current] [role="option"]:first-child`);
    await browser("click", `${dock} [data-dock-submit]`);
    await browser("wait", "--fn", `document.querySelector('${dock} [data-dock-receipt]') !== null`);
    expect(
      (await db.actionCard.findUniqueOrThrow({ where: { messageId: closed } })).result,
    ).toMatchObject({
      optionId: "red",
    });
    await browser("press", "Escape");
    await browser("wait", "--fn", `document.querySelector('${dock}') === null`);

    // Someone else's answer sits beside its question, with who gave it by face and name.
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
    await browser(
      "wait",
      "--fn",
      `document.querySelector('${card(others)}')?.dataset.questionCard === "executed"`,
    );
    expect(
      await evaluate<[string, string, boolean]>(`(() => {
        const el = document.querySelector('${card(others)}');
        const asked = el.querySelector("[data-question-row]").textContent;
        const status = el.lastElementChild.textContent;
        return [asked, status, el.lastElementChild.querySelector("[data-avatar]") !== null];
      })()`),
    ).toEqual([`Which one, peer? ${suffix}Red`, "Asked Peer", true]);
    await browser("screenshot", join(artifacts, "answered-by-peer.png"));

    // A phone: the dock is a sheet, the own-words row fits in it, and the page does not scroll
    // sideways.
    await browser("set", "viewport", "390", "844");
    await open();
    expect(
      await evaluate<boolean>(
        `document.documentElement.scrollWidth <= document.documentElement.clientWidth`,
      ),
    ).toBe(true);
    await openDock(shown);
    expect(
      await evaluate<boolean>(`(() => {
        const sheet = document.querySelector('${dock}').getBoundingClientRect();
        const own = document.querySelector('${input}').getBoundingClientRect();
        return document.querySelector('${dock}').getAttribute("role") === "dialog"
          && own.left >= sheet.left && own.right <= sheet.right
          && document.documentElement.scrollWidth <= document.documentElement.clientWidth;
      })()`),
    ).toBe(true);
    await browser("screenshot", join(artifacts, "phone.png"));
    await browser("set", "viewport", "1440", "900");

    // Closed without an answer, the card goes gray and says why; declined by the person asked, it
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
    await openDock(shown);
    expect(
      await evaluate<string | null>(
        `document.querySelector('${input}').getAttribute("placeholder")`,
      ),
    ).toBe("自己写…");
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
