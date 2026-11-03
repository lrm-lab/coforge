import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";

/**
 * A choice card's last row is the asked person's own answer (task #447), as Grok's is: the row is
 * itself an input ("Something else"), Enter sends the words, and the card closes to one line, the
 * question and the words (task #449). A blank Enter sends nothing. Anyone but the asked person sees
 * the options as a plain list, without that row. An option's number picks it from the keyboard,
 * and focus goes on to the next card waiting on the viewer.
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
  const { workspaceId, workspace } = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id },
    include: { workspace: { select: { slug: true } } },
  });
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
  const shown = await ask(`Which colour? ${suffix}`, DEV_BROWSER_USER.id);
  const answered = await ask(`Which shade? ${suffix}`, DEV_BROWSER_USER.id);
  const others = await ask(`Which one, peer? ${suffix}`, peer.id);
  const keyed = await ask(`Which key? ${suffix}`, DEV_BROWSER_USER.id);
  const closed = await ask(`Red or blue only? ${suffix}`, DEV_BROWSER_USER.id, false);
  await db.conversation.update({ where: { id: channel.id }, data: { lastSequence: sequence } });

  const card = (id: string) => `[data-message-id="${id}"] [role="group"]`;
  const input = (id: string) => `${card(id)} input`;
  const cardText = (id: string) => `(document.querySelector('${card(id)}')?.textContent ?? "")`;
  const page = (locale: string) => `${origin}/${locale}/w/${workspace.slug}/channel/${channel.id}`;
  const open = async (locale = "en") => {
    await browser("open", page(locale));
    await browser(
      "wait",
      "--fn",
      `document.querySelector('${input(shown)}') !== null && ${cardText(others)} !== "" && ${pageHydrated}`,
    );
  };
  try {
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1440", "900");
    await open();
    // The row after the options is an input named by its placeholder.
    expect(
      await evaluate<[string | null, string | null]>(
        `(() => { const el = document.querySelector('${input(shown)}'); return [el.getAttribute("aria-label"), el.getAttribute("placeholder")]; })()`,
      ),
    ).toEqual(["Something else", "Something else"]);
    // Someone else's card lists the options, with nothing to type in or press: its one button is
    // Dismiss, there for the Agent's owner.
    expect(await evaluate<boolean>(`document.querySelector('${input(others)}') === null`)).toBe(
      true,
    );
    expect(
      await evaluate<string[]>(
        `[...document.querySelectorAll('${card(others)} button')].map((b) => b.textContent)`,
      ),
    ).toEqual(["Dismiss"]);
    expect(await evaluate<boolean>(`${cardText(others)}.includes("Something else")`)).toBe(false);
    await browser("screenshot", join(artifacts, "light.png"));

    // Without that row, the asked person is pointed at the chat: the hint puts the caret in the
    // composer, and the card still waits. Someone else's card never shows the hint.
    const hint = `${card(closed)} > div > button`;
    expect(await evaluate<boolean>(`document.querySelector('${input(closed)}') === null`)).toBe(
      true,
    );
    expect(await evaluate<string>(`document.querySelector('${hint}').textContent`)).toBe(
      "or answer in the chat below",
    );
    expect(
      await evaluate<boolean>(`document.querySelector('${card(others)} > div > button') === null`),
    ).toBe(true);
    // Four cards overflow the pane; the last one's hint starts under the composer.
    await browser("eval", `document.querySelector('${hint}').scrollIntoView({ block: "center" })`);
    await browser("click", hint);
    await browser(
      "wait",
      "--fn",
      `document.activeElement?.matches("textarea[data-composer]") === true`,
    );
    expect((await db.actionCard.findUniqueOrThrow({ where: { messageId: closed } })).state).toBe(
      "pending",
    );
    await browser("screenshot", join(artifacts, "chat-hint.png"));

    // A blank Enter sends nothing.
    await browser("click", input(answered));
    await browser("press", "Enter");
    // Nothing is sent: no request fails (the server refuses a blank answer, and the card would say
    // so), the row is still there to type in, and the card still waits.
    await Bun.sleep(1_000);
    expect(
      await evaluate<boolean>(
        `document.querySelector('${card(answered)} [role="alert"]') === null && document.querySelector('${input(answered)}') !== null`,
      ),
    ).toBe(true);
    expect((await db.actionCard.findUniqueOrThrow({ where: { messageId: answered } })).state).toBe(
      "pending",
    );

    // The words, then Enter: the card closes to the question and the words.
    await browser("fill", input(answered), "  Teal, but darker  ");
    await browser("press", "Enter");
    await browser(
      "wait",
      "--fn",
      `${cardText(answered)}.includes("Teal, but darker") && document.querySelector('${input(answered)}') === null`,
    );
    expect(await evaluate<boolean>(`${cardText(answered)}.includes("Red")`)).toBe(false);
    const stored = await db.actionCard.findUniqueOrThrow({ where: { messageId: answered } });
    expect(stored.state).toBe("executed");
    expect(stored.result).toMatchObject({ optionId: "_other", text: "Teal, but darker" });
    await browser("screenshot", join(artifacts, "answered.png"));

    // From the keyboard: with a row focused, the card shows each option's number, and a number
    // picks it. Focus goes on to the next card waiting on the viewer (the peer's is skipped).
    await evaluate(`document.querySelector('${card(keyed)} [data-choice-row]').focus() ?? true`);
    await browser("press", "Tab");
    await browser("press", "Shift+Tab");
    await browser("screenshot", join(artifacts, "keyboard.png"));
    await browser("press", "2");
    await browser("wait", "--fn", `document.querySelector('${input(keyed)}') === null`);
    expect(
      (await db.actionCard.findUniqueOrThrow({ where: { messageId: keyed } })).result,
    ).toMatchObject({ optionId: "blue" });
    expect(await evaluate<string>(cardText(keyed))).toContain("Blue");
    expect(
      await evaluate<boolean>(
        `document.querySelector('${card(closed)}').contains(document.activeElement)`,
      ),
    ).toBe(true);
    await browser("screenshot", join(artifacts, "keyboard-picked.png"));

    // Someone else's answer is followed by their name; when they answered is the answer's tooltip
    // (React Aria opens one on hover once the page has seen a pointer press).
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
    await browser("wait", "--fn", `${cardText(others)}.includes("· Asked Peer")`);
    expect(await evaluate<string>(cardText(others))).toBe(
      `Which one, peer? ${suffix} Red· Asked Peer`,
    );
    await browser("click", "textarea[data-composer]");
    await browser("hover", `${card(others)} button`);
    await browser("wait", "--fn", `document.querySelector('[role="tooltip"]') !== null`);
    await browser("screenshot", join(artifacts, "answered-by-peer.png"));

    await open("zh-CN");
    expect(
      await evaluate<string | null>(
        `document.querySelector('${input(shown)}').getAttribute("placeholder")`,
      ),
    ).toBe("写别的答案…");
    await browser("screenshot", join(artifacts, "zh.png"));

    await browser("eval", `localStorage.setItem("coforge-theme", "dark")`);
    await open();
    await browser("screenshot", join(artifacts, "dark.png"));
    await browser("eval", `localStorage.removeItem("coforge-theme")`);

    // A phone: the row fits, and the page does not scroll sideways.
    await browser("set", "viewport", "390", "844");
    await open();
    expect(
      await evaluate<boolean>(
        `document.documentElement.scrollWidth <= document.documentElement.clientWidth`,
      ),
    ).toBe(true);
    await browser("screenshot", join(artifacts, "phone.png"));
  } finally {
    await browser("eval", `localStorage.removeItem("coforge-theme")`).catch(() => undefined);
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
