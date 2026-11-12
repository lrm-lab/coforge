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
 * card，看不出来已提交和未提交"): still waiting on them, answered by them behind a green check,
 * ignored by them, or withdrawn, each said in words on the card's last line, on a questions card
 * as on a choice card. Seeds an Agent asking a second person five cards; screenshots in light,
 * dark and on a phone go to `.amp/e2e/card-outcome/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/card-outcome");

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
    evaluate<{ kind: string | null; text: string } | null>(
      `(() => { const line = ${card(id)}?.querySelector("[data-card-outcome]"); return line && { kind: line.getAttribute("data-card-outcome"), text: line.textContent.replace(/\\s+/g, " ").trim() }; })()`,
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
    // Waiting: no outcome yet, only whom it waits on.
    expect(await outcome(waiting)).toBeNull();
    expect(await evaluate<string>(`${card(waiting)}.textContent`)).toContain("Waiting for");
    expect(await outcome(answered)).toEqual({ kind: "answered", text: "Jing Peer answered" });
    expect(await outcome(ignored)).toEqual({ kind: "ignored", text: "Jing Peer ignored it" });
    expect(await outcome(withdrawn)).toEqual({ kind: "cancelled", text: "Cancelled" });
    expect(await outcome(choiceIgnored)).toEqual({ kind: "ignored", text: "Jing Peer ignored it" });

    const shoot = async (name: string) => {
      await evaluate(`(${card(answered)}.scrollIntoView({ block: "center" }), true)`);
      await browser("wait", "300");
      await browser("screenshot", join(artifacts, `${name}.png`));
    };
    await shoot("en-1440");
    await open("zh-CN");
    expect((await outcome(answered))?.text).toBe("Jing Peer 已回答");
    expect((await outcome(ignored))?.text).toBe("Jing Peer 已忽略");
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
