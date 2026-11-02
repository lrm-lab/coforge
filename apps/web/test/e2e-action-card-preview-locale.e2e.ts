import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { ActionCards } from "#src/server/conversations/action-cards.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";

/**
 * An action card's line reads in the viewer's language wherever a list shows it in place of the
 * card (task #443): the Chat sidebar's channel and DM rows, Activity and search, while a search
 * still matches its stored English body, and the text a screen reader reads for the card in the
 * conversation.
 *
 * Opt-in like the other browser E2Es: real local Web + `agent-browser`. The channel, its Agent
 * and both cards are seeded per run and removed after it. Screenshots, in English and Chinese, are
 * written under `.amp/e2e/action-card-preview-locale/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/action-card-preview-locale");

test("an action card's preview line reads in the viewer's language", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `card-preview-${process.pid}`);
  const suffix = `${process.pid}-${Date.now()}`;
  const { workspaceId, workspace } = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id },
    include: { workspace: { select: { slug: true } } },
  });
  const agent = await db.agent.create({
    data: {
      workspaceId,
      name: `e2e-card-agent-${suffix}`,
      displayName: "Card Agent",
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
      channelName: `e2e-cards-${suffix}`,
      description: "",
      members: { create: [{ userId: DEV_BROWSER_USER.id }, { agentId: agent.id }] },
    },
  });
  const cards = new ActionCards(db, new PrismaDirectConversationRepository(db));
  const principal = { workspaceId, agentId: agent.id };
  const launch = `launch-${suffix}`;
  const helper = `helper-${suffix}`;
  const channelCard = await cards.prepare(principal, {
    target: `#${channel.channelName}`,
    action: { type: "channel:create", name: launch, draftHint: "For the launch" },
  });
  const dmCard = await cards.prepare(principal, {
    target: `@${DEV_BROWSER_USER.username}`,
    action: { type: "agent:create", name: helper },
  });
  const dm = await db.message.findUniqueOrThrow({
    where: { id: dmCard.messageId },
    select: { conversationId: true },
  });
  const lines = {
    en: {
      channel: `Action card: create channel #${launch}`,
      dm: `Action card: create agent ${helper}`,
    },
    "zh-CN": { channel: `操作卡片：创建群聊 #${launch}`, dm: `操作卡片：创建 Agent ${helper}` },
  };
  /** The text of the links on the page that open `conversationId`: its sidebar row, its
   * Activity row. */
  const rowText = (conversationId: string) =>
    `[...document.querySelectorAll('a[href*="${conversationId}"]')].map((link) => link.textContent).join(" | ")`;
  const has = (expression: string, text: string) =>
    `(${expression}).includes(${JSON.stringify(text)})`;
  try {
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1440", "900");
    for (const locale of ["zh-CN", "en"] as const) {
      const base = `${origin}/${locale}/w/${workspace.slug}`;
      const line = lines[locale];

      // The sidebar's channel and DM rows, beside the conversation that holds the card. A screen
      // reader reads the card in the conversation as the same line.
      await browser("open", `${base}/channel/${channel.id}`);
      await browser(
        "wait",
        "--fn",
        `${has(rowText(channel.id), line.channel)} && ${has(rowText(dm.conversationId), line.dm)} && ${pageHydrated}`,
      );
      expect(
        await evaluate<string>(
          `document.querySelector('[data-message-id="${channelCard.messageId}"] .sr-only').textContent`,
        ),
      ).toBe(`${line.channel}\nFor the launch`);
      await browser("screenshot", join(artifacts, `sidebar-${locale}.png`));

      // Activity's row for the DM.
      await browser("open", `${base}/activity`);
      await browser(
        "wait",
        "--fn",
        `${has(rowText(dm.conversationId), line.dm)} && ${pageHydrated}`,
      );
      await browser("screenshot", join(artifacts, `activity-${locale}.png`));

      // Search matches the stored English body and shows the line in the viewer's language.
      await browser("open", `${base}/search?q=${encodeURIComponent(launch)}`);
      const hit = `document.querySelector('[data-search-message-id="${channelCard.messageId}"]')?.textContent ?? ""`;
      await browser("wait", "--fn", `${has(hit, line.channel)} && ${pageHydrated}`);
      await browser("screenshot", join(artifacts, `search-${locale}.png`));
    }
  } finally {
    await browser("close").catch(() => undefined);
    await db.conversation
      .deleteMany({ where: { id: { in: [channel.id, dm.conversationId] } } })
      .catch(() => undefined);
    await db.agentMessageDelivery
      .deleteMany({ where: { agentId: agent.id } })
      .catch(() => undefined);
    await db.agent.deleteMany({ where: { id: agent.id } }).catch(() => undefined);
    await db.$disconnect();
  }
}, 180_000);
