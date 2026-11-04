import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { CentrifugoConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import { DirectConversations } from "#src/server/conversations/direct-conversations.server";
import { getMessageRequestIdempotency } from "#src/server/conversations/redis-message-request-idempotency.server";
import { browserActivityInbox } from "#src/server/inbox/browser-activity-inbox.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";
import { sameOriginProxy } from "./helpers/same-origin-proxy";

/**
 * Task #488: a message read where it arrives leaves the Activity dot dark. The viewer has a DM open
 * at its latest message; a member writes in it. The message lights the dot without a read
 * (`activityNavAttentionRealtime`'s `onMessage`), the open DM reads it at once, and that read's
 * `dm.marked.v1` makes the lit dot ask the server again, which has nothing unread. Before the fix
 * the dot stayed lit while Activity's Unread was empty.
 *
 * Opt-in like the other browser E2Es: a real local Web and Centrifugo (`COFORGE_E2E_CENTRIFUGO_URL`,
 * reached through the page's own origin), the dev user, `agent-browser`. The member and the DM are
 * seeded per run and removed after it. Screenshots go under `.amp/e2e/activity-dot-read-in-place/`.
 */
const { origin: webOrigin, browserPath, databaseUrl } = localBrowserE2e();
const centrifugoOrigin = Bun.env.COFORGE_E2E_CENTRIFUGO_URL;
if (!centrifugoOrigin) throw new Error("COFORGE_E2E_CENTRIFUGO_URL is required");
const artifacts = join(import.meta.dir, "../../../.amp/e2e/activity-dot-read-in-place");

test("a DM message read where it arrives leaves the Activity dot dark", async () => {
  const proxy = sameOriginProxy(webOrigin, centrifugoOrigin);
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `activity-dot-${process.pid}`);
  const { workspaceId, workspace } = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id },
    include: { workspace: { select: { slug: true } } },
  });
  const tail = `${process.pid}-${Date.now()}`.slice(-6);
  const mei = await db.user.create({ data: { username: `mei-${tail}`, displayName: "Mei Chen" } });
  await db.workspaceMembership.create({ data: { workspaceId, userId: mei.id } });
  const centrifugo = createCentrifugoServerApi();
  const realtime = new CentrifugoConversationRealtime(centrifugo);
  const dms = new DirectConversations(db, realtime);
  const dot = `document.querySelector('a[href*="/activity"] span[aria-hidden="true"].rounded-full')`;
  const shoot = async (shot: string) => {
    await browser("screenshot", join(artifacts, `${shot}.png`));
    await evaluate(`document.documentElement.classList.add("dark-mode") ?? true`);
    await browser("screenshot", join(artifacts, `${shot}-dark.png`));
    await evaluate(`document.documentElement.classList.remove("dark-mode") ?? true`);
  };
  let conversationId: string | undefined;
  try {
    ({ conversationId } = await dms.open(workspaceId, DEV_BROWSER_USER.id, { userId: mei.id }));
    // Nothing else unread, so the dot shows this message alone.
    await browserActivityInbox(db, centrifugo).markAllRead(workspaceId, DEV_BROWSER_USER.id, {
      before: new Date(),
    });
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1440", "900");
    await browser("open", `${proxy.origin}/en/w/${workspace.slug}/dm/${conversationId}`);
    await browser("wait", "--fn", `${pageHydrated} && ${dot} === null`);

    const send = (body: string) =>
      dms.send(
        workspaceId,
        mei.id,
        conversationId!,
        { idempotencyKey: crypto.randomUUID(), body },
        { idempotency: getMessageRequestIdempotency(), centrifugo, realtime },
      );
    // The first read of a visit refreshes Activity anyway; the ones after it are the case.
    for (const body of ["Are you around?", "The launch plan is ready for review."]) {
      await send(body);
      await browser("wait", "--fn", `document.body.textContent.includes(${JSON.stringify(body)})`);
    }
    // The open DM read both: the dot goes dark and stays so.
    await browser("wait", "--fn", `${dot} === null`);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(await evaluate<boolean>(`${dot} === null`)).toBe(true);
    await shoot("desktop-dm-read");

    // Unread elsewhere still lights it: the dot is not simply switched off.
    await browser("open", `${proxy.origin}/en/w/${workspace.slug}/tasks`);
    await browser("wait", "--fn", pageHydrated);
    await send("One more thing when you are back.");
    await browser("wait", "--fn", `${dot} !== null`);
    // That was the page lighting it; a reload asks the server, which agrees.
    await browser("reload");
    await browser("wait", "--fn", `${pageHydrated} && ${dot} !== null`);
    await shoot("desktop-unread-elsewhere");
  } finally {
    await browser("close").catch(() => undefined);
    proxy.stop();
    if (conversationId)
      await db.conversation.deleteMany({ where: { id: conversationId } }).catch(() => undefined);
    await db.workspaceMembership.deleteMany({ where: { userId: mei.id } }).catch(() => undefined);
    await db.user.delete({ where: { id: mei.id } }).catch(() => undefined);
    await db.$disconnect();
  }
}, 180_000);
