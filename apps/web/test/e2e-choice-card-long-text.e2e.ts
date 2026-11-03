import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { CHOICE_OTHER_TEXT_MAX_LENGTH, choiceActionSchema } from "@lrm/coforge-sdk/agent";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";

/**
 * A choice card with text as long as the server allows (task #449): a long question, long options,
 * one of them an unbroken URL, and long answers. Every word stays on screen: the card wraps, never
 * cuts, never runs past the message column or makes the page scroll sideways, and an option's
 * number stays at its row's end. Handled cards wrap their one line the same way, on a desktop and on a phone.
 *
 * Opt-in like the other browser E2Es: real local Web + `agent-browser`. The channel, its Agent, a
 * second member and the cards are seeded per run and removed after it. Screenshots are written
 * under `.amp/e2e/choice-card-long-text/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/choice-card-long-text");

/** `text` repeated and cut to exactly `length` characters: the server's limit, not past it. */
const exactly = (text: string, length: number) =>
  text.repeat(Math.ceil(length / text.length)).slice(0, length);

// At the server's hard limits (QA's list, #449 thread): a 200-character question without spaces,
// eight options of 80 characters each (long Chinese, a long English sentence, an unbroken URL, a
// long @handle) and a 200-character answer of the person's own.
const QUESTION = exactly(
  "发布前要先跑哪一套检查这次改动同时碰了消息列表的虚拟滚动卡片的键盘交互和服务端的状态迁移我担心只跑单元测试会漏掉浏览器里的回归但全量检查要四十分钟会推迟今天下午的发布窗口你来决定吧",
  200,
);
const OPTIONS = [
  exactly(
    "只跑单元测试和类型检查端到端测试留到明天早上统一补跑有问题再回滚这次发布并在频道里同步进度",
    80,
  ),
  exactly(
    "Run the unit tests plus the end-to-end suites that touch cards and the message list ",
    80,
  ),
  exactly(
    "https://github.com/example/coforge/actions/runs/41566364184/job/116452907312?pr=4521",
    80,
  ),
  exactly(
    "让 @release-coordinator-for-the-web-and-daemon-packages-team-alpha-and-beta 来决定吧",
    80,
  ),
  "全部检查，包括性能基准",
  "先发灰度百分之五观察一小时",
  "Ship it",
  "今天不发了",
];
const PEER_NAME = "Jordan Alexandria Montgomery-Westbrook the Third";
const OWN_ANSWER = exactly(
  "都不选：先在预发环境跑全量检查，同时把发布窗口挪到明天上午十点，今晚我会盯着结果，有失败就在这个频道里直接叫我，不用等到早上。",
  200,
);

test("a choice card keeps very long text on screen, wrapped, on a desktop and a phone", async () => {
  // The data is what an Agent can really send: the server's own schema accepts it.
  choiceActionSchema.parse({
    type: "choice",
    prompt: QUESTION,
    to: "@someone",
    options: OPTIONS.map((label, index) => ({ id: `o${index}`, label })),
  });
  expect(QUESTION.length).toBe(200);
  expect(OWN_ANSWER.length).toBe(CHOICE_OTHER_TEXT_MAX_LENGTH);
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `choice-long-${process.pid}`);
  const suffix = `${process.pid}-${Date.now()}`;
  const { workspaceId, workspace } = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id },
    include: { workspace: { select: { slug: true } } },
  });
  const peer = await db.user.create({
    data: { username: `e2e-long-peer-${suffix}`, displayName: PEER_NAME },
  });
  await db.workspaceMembership.create({ data: { workspaceId, userId: peer.id } });
  const agent = await db.agent.create({
    data: {
      workspaceId,
      name: `e2e-long-agent-${suffix}`,
      displayName: "Atlas",
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
      channelName: `e2e-long-${suffix}`,
      description: "",
      members: {
        create: [{ userId: DEV_BROWSER_USER.id }, { userId: peer.id }, { agentId: agent.id }],
      },
    },
    include: { members: true },
  });
  const agentMember = channel.members.find((member) => member.agentId === agent.id)!;
  let sequence = 0;
  /** A long choice card asking `to`; `answer` stores it as already answered by `by`. */
  const ask = async (
    to: string,
    answer?: { optionId: string; label: string; text?: string; by: string },
  ) => {
    sequence += 1;
    const message = await db.message.create({
      data: {
        workspaceId,
        conversationId: channel.id,
        sequence,
        senderMemberId: agentMember.id,
        body: QUESTION,
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
          prompt: QUESTION,
          options: OPTIONS.map((label, index) => ({ id: `o${index}`, label })),
          to,
          other: {},
        },
        preparedByAgentId: agent.id,
        ...(answer && {
          state: "executed",
          committedByUserId: answer.by,
          committedAt: new Date(),
          result: { optionId: answer.optionId, label: answer.label, text: answer.text },
        }),
      },
    });
    return message.id;
  };
  const answeredByPeer = await ask(peer.id, { optionId: "o1", label: OPTIONS[1]!, by: peer.id });
  const ownWords = await ask(DEV_BROWSER_USER.id, {
    optionId: "_other",
    label: "Something else",
    text: OWN_ANSWER,
    by: DEV_BROWSER_USER.id,
  });
  const forPeer = await ask(peer.id);
  const forMe = await ask(DEV_BROWSER_USER.id);
  await db.conversation.update({ where: { id: channel.id }, data: { lastSequence: sequence } });

  const card = (id: string) => `[data-message-id="${id}"] [role="group"]`;
  const open = async () => {
    await browser("open", `${origin}/en/w/${workspace.slug}/channel/${channel.id}`);
    await browser(
      "wait",
      "--fn",
      `document.querySelector('${card(forMe)} input') !== null && ${pageHydrated}`,
    );
  };
  /** Whether every card stays inside its message column, nothing is cut, and the page does not
   * scroll sideways; and where each option's number sits against its row's right edge. */
  const measure = () =>
    evaluate<{
      fits: boolean;
      overflowing: string[];
      numbersAtEnd: boolean;
      texts: string[];
    }>(`(() => {
      const ids = ${JSON.stringify([answeredByPeer, ownWords, forPeer, forMe])};
      const cards = ids.map((id) => document.querySelector('[data-message-id="' + id + '"] [role="group"]'));
      const overflowing = [];
      for (const el of cards) {
        const column = el.parentElement.getBoundingClientRect();
        if (el.getBoundingClientRect().right > column.right + 0.5) overflowing.push("card past column");
        for (const node of el.querySelectorAll("p, span, li, button")) {
          // A long answerer's name is cut on purpose (the answer's tooltip names them in full).
          const nameCut = node.textContent.startsWith("· ");
          if (!nameCut && node.scrollWidth > node.clientWidth + 1 && getComputedStyle(node).overflowX !== "visible")
            overflowing.push("cut: " + node.textContent.slice(0, 30));
          // Nothing inside runs past the column either, where an ancestor would clip it.
          if (node.getBoundingClientRect().right > column.right + 0.5)
            overflowing.push("past column: " + node.textContent.slice(0, 30));
        }
      }
      const rows = [...document.querySelectorAll('[data-message-id="${forMe}"] [data-choice-row]')].filter((row) => row.tagName === "BUTTON");
      const numbersAtEnd = rows.every((row) => {
        const kbd = row.querySelector("kbd");
        return !kbd || row.getBoundingClientRect().right - kbd.getBoundingClientRect().right < 16;
      });
      return {
        fits: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        overflowing,
        numbersAtEnd,
        texts: cards.map((el) => el.textContent),
      };
    })()`);
  try {
    await mkdir(artifacts, { recursive: true });
    for (const [width, height, name] of [
      ["1440", "900", "desktop"],
      ["390", "844", "phone"],
    ] as const) {
      await browser("set", "viewport", width, height);
      await open();
      // Before anything has focus (task #457): every option's number shows, and the waiting card's
      // question is cut to two lines, a press on it showing the rest.
      expect(
        await evaluate<boolean>(`(() => {
          const rows = [...document.querySelectorAll('${card(forMe)} button[data-choice-row]')];
          return rows.length > 0 && rows.every((row) => {
            const kbd = row.querySelector("kbd");
            return kbd !== null && getComputedStyle(kbd).visibility === "visible";
          });
        })()`),
      ).toBe(true);
      const pendingQuestion = `document.querySelector('${card(forMe)} [data-choice-question]')`;
      const questionLines = `Math.round(${pendingQuestion}.getBoundingClientRect().height / parseFloat(getComputedStyle(${pendingQuestion}).lineHeight))`;
      expect(await evaluate<number>(questionLines)).toBe(2);
      await evaluate(
        `document.querySelector('${card(forMe)} [data-choice-question]').scrollIntoView({ block: "center" }) ?? true`,
      );
      await browser("screenshot", join(artifacts, `${name}-waiting-cut.png`));
      await browser("click", `${card(forMe)} button[aria-expanded="false"]`);
      expect(await evaluate<number>(questionLines)).toBeGreaterThan(2);
      // Keyboard focus in the card.
      await evaluate(`document.querySelector('${card(forMe)} [data-choice-row]').focus() ?? true`);
      await browser("press", "Tab");
      await browser("press", "Shift+Tab");
      const result = await measure();
      expect(result.fits).toBe(true);
      expect(result.overflowing).toEqual([]);
      expect(result.numbersAtEnd).toBe(true);
      // Every word is there: the question, each option, the answers and who gave them.
      const [peerLine, ownLine, peerCard, myCard] = result.texts;
      expect(peerLine).toContain(QUESTION);
      expect(peerLine).toContain(`${OPTIONS[1]}· ${PEER_NAME}`);
      expect(ownLine).toContain(OWN_ANSWER);
      for (const option of OPTIONS) {
        expect(peerCard).toContain(option);
        expect(myCard).toContain(option);
      }
      await evaluate(
        `document.querySelector('${card(answeredByPeer)}').scrollIntoView({ block: "start" }) ?? true`,
      );
      // Handled, the question shows two lines at most; the answer is whole. A press shows the rest.
      const question = `document.querySelector('${card(answeredByPeer)} button[aria-expanded="false"]')`;
      const lines = (el: string) =>
        `Math.round(${el}.getBoundingClientRect().height / parseFloat(getComputedStyle(${el}).lineHeight))`;
      expect(await evaluate<number>(lines(question))).toBe(2);
      await browser("screenshot", join(artifacts, `${name}-handled.png`));
      await browser("click", `${card(answeredByPeer)} button[aria-expanded="false"]`);
      const whole = `document.querySelector('${card(answeredByPeer)} p > span')`;
      expect(await evaluate<number>(lines(whole))).toBeGreaterThan(2);
      await browser("screenshot", join(artifacts, `${name}-handled-expanded.png`));
      await evaluate(
        `document.querySelector('${card(forMe)}').scrollIntoView({ block: "end" }) ?? true`,
      );
      await browser("screenshot", join(artifacts, `${name}-waiting.png`));
      // A long answer typed into the last row scrolls inside it, the Enter key staying in view.
      await browser("fill", `${card(forMe)} input`, OWN_ANSWER);
      expect(
        await evaluate<boolean>(`(() => {
          const row = document.querySelector('${card(forMe)} label');
          const kbd = row.querySelector("kbd");
          return kbd !== null && kbd.getBoundingClientRect().right <= row.getBoundingClientRect().right;
        })()`),
      ).toBe(true);
      await browser("screenshot", join(artifacts, `${name}-typing.png`));
      await evaluate(`document.documentElement.classList.add("dark-mode") ?? true`);
      await evaluate(
        `document.querySelector('${card(answeredByPeer)}').scrollIntoView({ block: "start" }) ?? true`,
      );
      await browser("screenshot", join(artifacts, `${name}-dark.png`));
      await evaluate(`document.documentElement.classList.remove("dark-mode") ?? true`);
    }
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
