import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { CHOICE_OTHER_TEXT_MAX_LENGTH, choiceActionSchema } from "@lrm/coforge-sdk/agent";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import {
  browserSession,
  devBrowserWorkspace,
  localBrowserE2e,
  pageHydrated,
} from "./helpers/browser-e2e";

/**
 * A choice card with text as long as the server allows (task #449): a long question, long options,
 * one of them an unbroken URL, and long answers. In the stream a card is one line per question,
 * cut with an ellipsis, and never runs past the message column or makes the page scroll sideways.
 * In the dock every word stays on screen: the question and the options wrap, nothing is cut, an
 * option's number stays at its row's end, the own-words row takes the longest answer, and the
 * receipt after sending carries it within the dock's width. On a desktop and on a phone, where the dock is a sheet.
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
  const { workspaceId, workspace } = await devBrowserWorkspace(db);
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
  // One card to answer on each viewport: sending it ends its run.
  const forMe = { desktop: await ask(DEV_BROWSER_USER.id), phone: await ask(DEV_BROWSER_USER.id) };
  await db.conversation.update({ where: { id: channel.id }, data: { lastSequence: sequence } });

  const card = (id: string) => `[data-message-id="${id}"] [data-question-card]`;
  const dock = "[data-question-dock]";
  const open = async (waiting: string) => {
    await browser("open", `${origin}/en/w/${workspace.slug}/channel/${channel.id}`);
    await browser(
      "wait",
      "--fn",
      `document.querySelector('${card(waiting)}[data-question-card="pending"]') !== null && ${pageHydrated}`,
    );
  };
  /** The cards in the stream: each inside its message column, nothing past it (a cut line ends in
   * an ellipsis on purpose), the page not scrolling sideways, one line to a question. */
  const measureStream = () =>
    evaluate<{ fits: boolean; overflowing: string[]; tall: string[]; texts: string[] }>(`(() => {
      const ids = ${JSON.stringify([answeredByPeer, ownWords, forPeer, forMe.desktop, forMe.phone])};
      const cards = ids.map((id) => document.querySelector('[data-message-id="' + id + '"] [data-question-card]'));
      const overflowing = [];
      const tall = [];
      for (const el of cards) {
        const column = el.parentElement.getBoundingClientRect();
        if (el.getBoundingClientRect().right > column.right + 0.5) overflowing.push("card past column");
        for (const node of el.querySelectorAll("span, button, time")) {
          // Inside a line cut on purpose, a name's own box runs on, clipped by the line.
          let clipped = false;
          for (let up = node.parentElement; up && up !== el; up = up.parentElement)
            if (getComputedStyle(up).overflowX !== "visible") clipped = true;
          if (!clipped && node.getBoundingClientRect().right > column.right + 0.5)
            overflowing.push("past column: " + node.textContent.slice(0, 30));
        }
        for (const row of el.querySelectorAll("[data-question-row]"))
          if (row.getBoundingClientRect().height > 30) tall.push(row.textContent.slice(0, 30));
      }
      return {
        fits: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        overflowing,
        tall,
        texts: cards.map((el) => el.textContent),
      };
    })()`);
  /** The dock: nothing cut or past its edge, no sideways scroll inside it, the question whole,
   * and where each option's number sits against its row's right edge. */
  const measureDock = () =>
    evaluate<{
      overflowing: string[];
      scrollsSideways: boolean;
      titleWhole: boolean;
      numbersAtEnd: boolean;
      options: string[];
    }>(`(() => {
      const root = document.querySelector('${dock}');
      const edge = root.getBoundingClientRect().right;
      const overflowing = [];
      for (const node of root.querySelectorAll("p, span, div[role=option]")) {
        if (node.closest("time")) continue;
        if (node.scrollWidth > node.clientWidth + 1 && getComputedStyle(node).overflowX !== "visible")
          overflowing.push("cut: " + node.textContent.slice(0, 30));
        if (node.getBoundingClientRect().right > edge + 0.5)
          overflowing.push("past dock: " + node.textContent.slice(0, 30));
      }
      const body = root.querySelector("[data-dock-page-current]").parentElement.parentElement;
      const title = root.querySelector("[data-dock-page-current] > p");
      const rows = [...root.querySelectorAll('[data-dock-page-current] [role="option"]')];
      return {
        overflowing,
        scrollsSideways: body.scrollWidth > body.clientWidth + 1,
        titleWhole: title.textContent === ${JSON.stringify(QUESTION)} && title.scrollHeight <= title.clientHeight + 1,
        numbersAtEnd: rows.every((row) => {
          const kbd = row.querySelector("kbd");
          return !kbd || kbd.getClientRects().length === 0 || row.getBoundingClientRect().right - kbd.getBoundingClientRect().right < 16;
        }),
        options: rows.map((row) => row.textContent),
      };
    })()`);
  try {
    await mkdir(artifacts, { recursive: true });
    for (const [width, height, name] of [
      ["1440", "900", "desktop"],
      ["390", "844", "phone"],
    ] as const) {
      const mine = forMe[name];
      await browser("set", "viewport", width, height);
      await open(mine);
      const stream = await measureStream();
      expect(stream.fits).toBe(true);
      expect(stream.overflowing).toEqual([]);
      expect(stream.tall).toEqual([]);
      // Every word is in the card, however it is cut on screen: the question, the answer and who
      // gave it, and the viewer's own words.
      const [peerLine, ownLine, peerCard] = stream.texts;
      expect(peerLine).toContain(QUESTION);
      expect(peerLine).toContain(OPTIONS[1]!);
      expect(peerLine).toContain(PEER_NAME);
      expect(ownLine).toContain(OWN_ANSWER);
      expect(peerCard).toContain(PEER_NAME);
      await evaluate(
        `document.querySelector('${card(answeredByPeer)}').scrollIntoView({ block: "start" }) ?? true`,
      );
      await browser("screenshot", join(artifacts, `${name}-stream.png`));

      // Answering opens the dock: the whole question and every option, wrapped.
      await browser("click", `[data-message-id="${mine}"] [data-question-card-answer]`);
      await browser(
        "wait",
        "--fn",
        `document.querySelector('${dock} [data-dock="answering"]') !== null`,
      );
      const answering = await measureDock();
      expect(answering.overflowing).toEqual([]);
      expect(answering.scrollsSideways).toBe(false);
      expect(answering.titleWhole).toBe(true);
      expect(answering.numbersAtEnd).toBe(true);
      expect(answering.options.length).toBe(OPTIONS.length + 1);
      for (const [index, option] of OPTIONS.entries())
        expect(answering.options[index]).toContain(option);
      await browser("screenshot", join(artifacts, `${name}-dock.png`));
      await evaluate(`document.documentElement.classList.add("dark-mode") ?? true`);
      await browser("screenshot", join(artifacts, `${name}-dock-dark.png`));
      await evaluate(`document.documentElement.classList.remove("dark-mode") ?? true`);

      // A long answer typed into the own-words row scrolls inside it, the row staying in the dock.
      await browser("fill", `${dock} [data-dock-other]`, OWN_ANSWER);
      expect(
        await evaluate<boolean>(`(() => {
          const input = document.querySelector('${dock} [data-dock-other]');
          const row = input.closest('[role="option"]');
          return input.value === ${JSON.stringify(OWN_ANSWER)}
            && input.getBoundingClientRect().right <= row.getBoundingClientRect().right
            && row.getBoundingClientRect().right <= document.querySelector('${dock}').getBoundingClientRect().right;
        })()`),
      ).toBe(true);
      await browser("screenshot", join(artifacts, `${name}-typing.png`));

      // Sent, the receipt holds the answer; the stream card shows it beside its question.
      await browser("click", `${dock} [data-dock-submit]`);
      await browser(
        "wait",
        "--fn",
        `document.querySelector('${dock} [data-dock-receipt]') !== null`,
      );
      const receipt = await evaluate<{ sideways: boolean; text: string }>(`(() => {
        const receipt = document.querySelector('${dock} [data-dock-receipt]');
        const answer = [...receipt.querySelectorAll("span")].find((el) => el.textContent === ${JSON.stringify(OWN_ANSWER)});
        const body = receipt.children[1];
        return {
          sideways: body.scrollWidth > body.clientWidth + 1,
          text: answer.textContent,
        };
      })()`);
      expect(receipt.text).toBe(OWN_ANSWER);
      expect(receipt.sideways).toBe(false);
      // The receipt clamps an answer to three lines (`line-clamp-3`), so its words are in the
      // page but not all on screen; that is not asserted here.
      await browser("screenshot", join(artifacts, `${name}-receipt.png`));
      await browser("press", "Escape");
      await browser("wait", "--fn", `document.querySelector('${dock}') === null`);
      await browser(
        "wait",
        "--fn",
        `document.querySelector('${card(mine)}[data-question-card="executed"]') !== null`,
      );
      expect(
        await evaluate<boolean>(
          `document.querySelector('${card(mine)}').textContent.includes(${JSON.stringify(OWN_ANSWER)})`,
        ),
      ).toBe(true);
      const stored = await db.actionCard.findUniqueOrThrow({ where: { messageId: mine } });
      expect(stored.state).toBe("executed");
      expect(stored.result).toMatchObject({ optionId: "_other", text: OWN_ANSWER });
      expect((await measureStream()).overflowing).toEqual([]);
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
