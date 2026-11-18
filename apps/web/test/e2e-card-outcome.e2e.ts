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
 * Looking at someone else's card, its state reads at a glance (Frank, task #94: "我看别人的 option
 * card，看不出来已提交和未提交"): still waiting on them ("Waiting on <name>"), answered by them
 * (their answers beside the questions, their name by face), declined by them ("<name> didn't
 * answer"), or withdrawn by someone else, each in the card's footer status and in
 * `data-question-card`, on a questions card as on a choice card; a card nobody will answer is
 * gray, its prompts still there. Read when mounted later, a handled card is compact
 * (`data-question-card-view`). Seeds an Agent asking a second person five cards; screenshots in
 * light, dark and on a phone go to `.artifacts/e2e/card-outcome/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.artifacts/e2e/card-outcome");

test("someone else's card says whether it waits, was answered, ignored or withdrawn", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `card-outcome-${process.pid}`);
  const { workspaceId, workspace } = await devBrowserWorkspace(db);
  const suffix = `${process.pid}-${Date.now()}`.slice(-6);
  const peer = await db.user.create({
    data: { username: `e2e-outcome-peer-${suffix}`, displayName: "Jing Peer" },
  });
  await db.workspaceMembership.create({ data: { workspaceId, userId: peer.id } });
  const agent = await db.agent.create({
    data: {
      workspaceId,
      name: `e2e-outcome-${suffix}`,
      displayName: `Outcome Agent ${suffix}`,
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
      channelName: `e2e-outcome-${suffix}`,
      description: "",
      members: {
        create: [{ userId: DEV_BROWSER_USER.id }, { userId: peer.id }, { agentId: agent.id }],
      },
    },
    include: { members: true },
  });
  const agentMember = channel.members.find((member) => member.agentId === agent.id)!;
  let sequence = 0;
  const QUESTIONS = [
    {
      id: "english",
      prompt: "English copy?",
      select: "one",
      options: [
        { id: "translate", label: "You translate, I review", recommended: true },
        { id: "write", label: "I write it" },
      ],
    },
    {
      id: "terminal",
      prompt: "Keep the terminal?",
      select: "one",
      options: [
        { id: "drop", label: "Drop it", recommended: true },
        { id: "keep", label: "Keep it" },
      ],
    },
  ];
  /** A card from the Agent asking the peer, closed as `close` says. */
  const ask = async (
    kind: "questions" | "choice",
    prompt: string,
    close: Record<string, unknown> = {},
  ) => {
    sequence += 1;
    const message = await db.message.create({
      data: {
        workspaceId,
        conversationId: channel.id,
        sequence,
        senderMemberId: agentMember.id,
        body: prompt,
      },
    });
    await db.actionCard.create({
      data: {
        messageId: message.id,
        conversationId: channel.id,
        workspaceId,
        kind,
        payload:
          kind === "questions"
            ? { type: "questions", prompt, questions: QUESTIONS, to: peer.id }
            : {
                type: "choice",
                prompt,
                options: [
                  { id: "red", label: "Red" },
                  { id: "blue", label: "Blue" },
                ],
                to: peer.id,
              },
        preparedByAgentId: agent.id,
        ...close,
      },
    });
    return message.id;
  };
  const at = new Date();
  const waiting = await ask("questions", `Still waiting ${suffix}`);
  const answered = await ask("questions", `Answered ${suffix}`, {
    state: "executed",
    committedByUserId: peer.id,
    committedAt: at,
    result: {
      answers: [
        {
          questionId: "english",
          selection: [{ optionId: "translate", label: "You translate, I review" }],
        },
        { questionId: "terminal", selection: [{ optionId: "drop", label: "Drop it" }] },
      ],
    },
  });
  const ignored = await ask("questions", `Ignored ${suffix}`, {
    state: "cancelled",
    committedByUserId: peer.id,
    committedAt: at,
  });
  const withdrawn = await ask("questions", `Withdrawn ${suffix}`, {
    state: "cancelled",
    committedByUserId: DEV_BROWSER_USER.id,
    committedAt: at,
  });
  const choiceIgnored = await ask("choice", `Which colour ${suffix}`, {
    state: "cancelled",
    committedByUserId: peer.id,
    committedAt: at,
  });
  await db.conversation.update({ where: { id: channel.id }, data: { lastSequence: sequence } });

  const card = (id: string) => `document.querySelector('[data-message-id="${id}"]')`;
  const outcome = (id: string) =>
    evaluate<{
      state: string | null;
      view: string | null;
      status: string;
      answers: string[];
      text: string;
      gray: string;
    } | null>(
      `(() => {
        const el = ${card(id)}?.querySelector("[data-question-card]");
        if (!el) return null;
        // How faded the card reads: the prompt's colour with the opacity of everything up to the card.
        const prompt = el.querySelector("[data-question-prompt]") ?? el;
        let opacity = 1;
        for (let up = prompt; up; up = up.parentElement) {
          opacity *= Number(getComputedStyle(up).opacity);
          if (up === el) break;
        }
        return {
          state: el.getAttribute("data-question-card"),
          view: el.getAttribute("data-question-card-view"),
          status: el.querySelector("[data-question-status]")?.textContent.replace(/\\s+/g, " ").trim() ?? "",
          answers: [...el.querySelectorAll("[data-question-answer]")].map((row) => row.textContent),
          text: el.textContent,
          gray: getComputedStyle(prompt).color + " / " + opacity,
        };
      })()`,
    );
  const open = async (locale: string) => {
    await browser("open", `${origin}/${locale}/w/${workspace.slug}/channel/${channel.id}`);
    await browser("wait", "--fn", `${pageHydrated} && !!${card(choiceIgnored)}`);
    await browser("wait", "800");
  };

  try {
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1440", "900");
    await open("en");
    // Waiting: nothing answered yet, only whom it waits on, and every question still to read.
    const waitingNow = (await outcome(waiting))!;
    expect(waitingNow.state).toBe("pending");
    expect(waitingNow.view).toBe("full");
    expect(waitingNow.text).toContain("Waiting on Jing Peer");
    expect(waitingNow.answers).toEqual([]);
    // Answered: their answers beside the questions, their name in the footer.
    const answeredNow = (await outcome(answered))!;
    expect(answeredNow.state).toBe("executed");
    expect(answeredNow.view).toBe("compact");
    expect(answeredNow.text).toContain("Jing Peer");
    expect(answeredNow.text).not.toContain("didn't answer");
    expect(answeredNow.answers).toHaveLength(2);
    expect(answeredNow.answers[0]).toContain("English copy?");
    expect(answeredNow.answers[0]).toContain("You translate, I review");
    expect(answeredNow.answers[1]).toContain("Keep the terminal?");
    expect(answeredNow.answers[1]).toContain("Drop it");
    // Closed without an answer: gray, no answers, the prompts still there, and why.
    for (const [id, status, prompt] of [
      [ignored, "Jing Peer didn't answer", "English copy?"],
      [withdrawn, "Withdrawn", "English copy?"],
      [choiceIgnored, "Jing Peer didn't answer", "Which colour"],
    ] as const) {
      const closed = (await outcome(id))!;
      expect(closed.state).toBe("cancelled");
      expect(closed.view).toBe("compact");
      expect(closed.status).toContain(status);
      expect(closed.answers).toEqual([]);
      expect(closed.text).toContain(prompt);
      expect(closed.text).not.toContain("You translate, I review");
      expect(closed.gray).not.toBe(waitingNow.gray);
    }

    const shoot = async (name: string) => {
      await evaluate(`(${card(answered)}.scrollIntoView({ block: "center" }), true)`);
      await browser("wait", "300");
      await browser("screenshot", join(artifacts, `${name}.png`));
    };
    await shoot("en-1440");
    await open("zh-CN");
    expect((await outcome(answered))?.text).toContain("Jing Peer");
    expect((await outcome(ignored))?.status).toContain("Jing Peer 没回答");
    expect((await outcome(withdrawn))?.status).toContain("已撤回");
    await shoot("zh-CN-1440");
    await evaluate(`(document.documentElement.classList.add("dark-mode"), true)`);
    await shoot("zh-CN-1440-dark");
    await evaluate(`(document.documentElement.classList.remove("dark-mode"), true)`);
    await browser("set", "viewport", "390", "844");
    await open("zh-CN");
    expect(
      await evaluate<boolean>(
        `document.documentElement.scrollWidth <= document.documentElement.clientWidth`,
      ),
    ).toBe(true);
    await shoot("zh-CN-390");
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
