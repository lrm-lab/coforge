import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "../src/server/auth/dev-skip-auth.server";
import { browserSession, localBrowserE2e, seededUuid } from "./helpers/browser-e2e";

/**
 * The regression that proved the boss's E2E-first policy (#790): a `<TooltipTrigger>` wrapper
 * slipped between the system-notice row's flex line and its `min-w-0 flex-1` span, the span
 * stopped being the flex item, a long notice grew the row past the container, and on a phone
 * the whole message stream scrolled sideways. tsc and the unit suites were all green — only a
 * narrow-viewport browser could see it.
 *
 * So this test pins that regression and is the first exemplar of the policy: at a phone
 * viewport, a channel holding pathologically long system notices must have NO horizontal
 * overflow anywhere — the page and the stream keep `scrollWidth <= clientWidth`, and each
 * notice stays a single clipped line.
 *
 * Opt-in like the other browser E2Es: real local Web (managed-web.sh) + `agent-browser`; the
 * long notices are seeded deterministically, so reruns restore the same rows instead of
 * duplicating them.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();

// The ASCII token far wider than a 390px viewport is the point: when the row's truncation
// chain holds, `truncate` clips it; when the flex chain breaks (min-width:auto back on a
// wrapped item), this token is what pushes the row — and the whole stream — sideways.
const NOTICES = [
  "任务 #9001 “为保存的视图建立移动端列宽的自适应规则与回退策略” - in progress · glm-5-3-flash",
  "system-notice-with-a-very-long-unbreakable-ascii-token-0123456789abcdef0123456789abcdef-end",
  "成员 @jordan 加入了频道，并由 @dev-user 授予了查看已保存消息与任务看板的权限，此通知特意写得足够长以覆盖多行场景。",
];

test("a phone viewport never scrolls the message stream sideways, even with long system notices", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `mobile-overflow-${process.pid}`);
  try {
    const membership = await db.workspaceMembership.findFirstOrThrow({
      where: { userId: DEV_BROWSER_USER.id },
      include: { workspace: { select: { slug: true } } },
    });
    const workspacePath = `/en/w/${membership.workspace.slug}`;
    const channel = await db.conversation.findFirstOrThrow({
      where: { workspaceId: membership.workspaceId, channelName: { not: null }, archivedAt: null },
      orderBy: { createdAt: "asc" },
    });
    // Seed the long system notices (a sender-less Message row renders as a system row) at the
    // channel's tail, deterministically addressed so a rerun restores instead of duplicating.
    const last = await db.message.aggregate({
      where: { conversationId: channel.id },
      _max: { sequence: true },
    });
    let sequence = Math.max(last._max.sequence ?? 0, channel.lastSequence) + 1;
    for (const body of NOTICES) {
      const id = seededUuid(`e2e-mobile-overflow:${body.slice(0, 40)}`);
      await db.message.upsert({
        where: { id },
        update: { body, sequence },
        create: {
          id,
          conversationId: channel.id,
          workspaceId: channel.workspaceId,
          body,
          sequence,
        },
      });
      // A system message without a structured row would fail the backfill's guard on a local
      // database this e2e seeded. Its body is deliberately unparseable, so it is legacy text.
      await db.systemMessage.upsert({
        where: { messageId: id },
        update: { kind: "legacy_text", params: { body } },
        create: {
          messageId: id,
          conversationId: channel.id,
          workspaceId: channel.workspaceId,
          kind: "legacy_text",
          params: { body },
        },
      });
      sequence += 1;
    }

    // The channel's read reaches only as far as its last sequence: without this the notices were
    // never loaded, and the test passed on whatever other notice happened to be on screen.
    await db.conversation.update({
      where: { id: channel.id },
      data: { lastSequence: sequence - 1 },
    });

    await browser("open", `${origin}${workspacePath}/channel/${channel.id}`);
    await browser("set", "viewport", "390", "844", "3");
    await browser("wait", "--url", `**/channel/${channel.id}`);
    // Consecutive notices fold into one summary line (task #412): open every group, so the long
    // notices this test seeded are drawn as rows.
    await browser("wait", "--fn", `document.querySelector("li[data-system-group]") !== null`);
    await browser(
      "eval",
      `document.querySelectorAll('li[data-system-group] button[aria-expanded="false"]').forEach((button) => button.click())`,
    );
    await browser(
      "wait",
      "--fn",
      `[...document.querySelectorAll('[data-message="system"]')].some((row) => row.textContent.includes("0123456789abcdef"))`,
    );
    // Every notice is one clipped line: an unclipped one (the regression) wraps or grows tall.
    await browser(
      "wait",
      "--fn",
      `Array.from(document.querySelectorAll('[data-message="system"]')).every(
        (row) => !row.textContent.includes("0123456789abcdef") || row.clientHeight <= 64,
      )`,
    );
    const overflow = await evaluate<{ page: number; stream: number; systemRows: number }>(
      `(() => {
          const page = document.documentElement.scrollWidth - document.documentElement.clientWidth;
          const stream = [...document.querySelectorAll("div")].find((e) =>
            e.className.includes("overflow-y-auto"),
          );
          return {
            page,
            stream: stream ? stream.scrollWidth - stream.clientWidth : -1,
            systemRows: document.querySelectorAll('[data-message="system"]').length,
          };
        })()`,
    );
    expect(overflow.systemRows).toBeGreaterThanOrEqual(NOTICES.length);
    expect(overflow.page).toBeLessThanOrEqual(1);
    expect(overflow.stream).toBeLessThanOrEqual(1);
  } finally {
    await browser("close").catch(() => undefined);
    await db.$disconnect();
  }
}, 60_000);
