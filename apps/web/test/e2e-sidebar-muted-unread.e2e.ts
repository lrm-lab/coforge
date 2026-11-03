import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";

/**
 * A muted channel with unread messages in the sidebar (task #420), as Raft draws it: a muted
 * icon beside the name, then the unread count as a quiet gray number (no badge); the row is
 * dimmed and not bold; an "@" still shows. A loud channel beside it for comparison.
 *
 * Opt-in like the other browser E2Es (real local Web and `agent-browser`). The channels are
 * seeded per run and removed after it. Screenshots go under `.amp/e2e/sidebar-muted-unread/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/sidebar-muted-unread");

test("a muted channel shows its unread as a quiet number beside the muted icon", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `sidebar-muted-${process.pid}`);
  const { workspaceId, workspace } = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id },
    include: { workspace: { select: { slug: true } } },
  });
  const tail = `${process.pid}-${Date.now()}`.slice(-5);
  const sender = await db.user.create({
    data: { username: `muted-sender-${tail}`, displayName: "Sender" },
  });
  const channels: string[] = [];
  const seed = async (name: string, count: number, level: "all" | "muted", mention: boolean) => {
    const channel = await db.conversation.create({
      data: { workspaceId, channelName: name, description: "" },
    });
    channels.push(channel.id);
    const me = await db.conversationMember.create({
      data: {
        workspaceId,
        conversationId: channel.id,
        userId: DEV_BROWSER_USER.id,
        notificationLevel: level,
        channelMuted: level === "muted",
        readThroughSequence: 0,
      },
    });
    const from = await db.conversationMember.create({
      data: { workspaceId, conversationId: channel.id, userId: sender.id },
    });
    for (let sequence = 1; sequence <= count; sequence += 1) {
      const message = await db.message.create({
        data: {
          workspaceId,
          conversationId: channel.id,
          sequence,
          senderMemberId: from.id,
          body:
            sequence === count && mention ? `@${DEV_BROWSER_USER.username} look` : `hi ${sequence}`,
        },
      });
      if (sequence === count && mention)
        await db.messageMention.create({
          data: {
            messageId: message.id,
            memberId: me.id,
            conversationId: channel.id,
            workspaceId,
            kind: "user",
            actorId: sender.id,
            handle: DEV_BROWSER_USER.username,
          },
        });
    }
  };
  try {
    await seed(`a-muted-${tail}`, 3, "muted", false);
    await seed(`a-muted-at-${tail}`, 12, "muted", true);
    await seed(`a-loud-${tail}`, 4, "all", false);
    await mkdir(artifacts, { recursive: true });
    const row = (name: string) =>
      `[...document.querySelectorAll("a")].find((a) => a.textContent.includes(${JSON.stringify(name)}))`;
    for (const [width, height, label] of [
      [1280, 860, "desktop"],
      [390, 844, "phone"],
    ] as const) {
      await browser("set", "viewport", String(width), String(height));
      await browser("open", `${origin}/zh-CN/w/${workspace.slug}`);
      await browser("wait", "--fn", `${pageHydrated} && ${row(`a-muted-at-${tail}`)} != null`);
      expect(await evaluate<boolean>(`${row(`a-muted-${tail}`)}.textContent.includes("3")`)).toBe(
        true,
      );
      await evaluate(`(${row(`a-muted-${tail}`)}.scrollIntoView({ block: "center" }), true)`);
      await browser(
        "wait",
        "--fn",
        `document.getAnimations().every((a) => a.playState !== "running")`,
      );
      await browser("screenshot", join(artifacts, `${label}.png`));
      await evaluate(`document.documentElement.classList.add("dark-mode") ?? true`);
      await browser("screenshot", join(artifacts, `${label}-dark.png`));
      await evaluate(`document.documentElement.classList.remove("dark-mode") ?? true`);
    }
  } finally {
    await browser("close").catch(() => undefined);
    await db.conversation.deleteMany({ where: { id: { in: channels } } }).catch(() => undefined);
    await db.user.delete({ where: { id: sender.id } }).catch(() => undefined);
    await db.$disconnect();
  }
}, 180_000);
