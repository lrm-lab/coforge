import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import {
  conversationRealtimeChannel,
  workspaceConversationChannel,
} from "#src/features/conversations/conversation-realtime";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { browserSession, localBrowserE2e, pageHydrated, seededUuid } from "./helpers/browser-e2e";
import { sameOriginProxy } from "./helpers/same-origin-proxy";

/**
 * A channel renamed, described, archived or unarchived in one tab reaches another open tab
 * without a reload: its sidebar row and its open channel page follow the change live.
 *
 * Opt-in like the other browser E2Es: real local Web + `agent-browser`, and this one also needs
 * browser realtime: Centrifugo reachable at the page's `/connection/websocket` and the Web's
 * browser-token signing key configured, as the E2E stack provides behind
 * `scripts/e2e/same-origin-proxy.ts` (`COFORGE_E2E_WEB_URL=http://127.0.0.1:8790`). The channel is seeded deterministically and reset on
 * every run. Screenshots are written under `.artifacts/e2e/channel-settings-realtime/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.artifacts/e2e/channel-settings-realtime");

const channelHeader = `document.querySelector("header h1[data-channel-title]")?.closest("header")`;
const sidebarHas = (name: string) =>
  `[...document.querySelectorAll("a")].some((link) => link.textContent.trim() === ${JSON.stringify(name)})`;
const panelSelector = 'section[aria-label="Channel details and settings"]';
const panelOpen = `document.querySelector('${panelSelector}') !== null`;

test("another open tab follows a channel's rename, description and archive live", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const watcherProxy = sameOriginProxy(origin, Bun.env.COFORGE_E2E_CENTRIFUGO_URL ?? origin);
  const editor = browserSession(browserPath, `channel-realtime-editor-${process.pid}`);
  const watcher = browserSession(browserPath, `channel-realtime-watcher-${process.pid}`);
  const channelId = seededUuid("e2e-channel-settings-realtime:channel");
  const channelName = "e2e-live";
  const renamed = "e2e-live-renamed";
  try {
    const membership = await db.workspaceMembership.findFirstOrThrow({
      where: { userId: DEV_BROWSER_USER.id },
      orderBy: { createdAt: "asc" },
      include: { workspace: { select: { slug: true } } },
    });
    const workspacePath = `/en/w/${membership.workspace.slug}`;
    const workspaceId = membership.workspaceId;
    await db.conversation.deleteMany({
      where: { workspaceId, channelName: renamed, NOT: { id: channelId } },
    });
    await db.conversation.upsert({
      where: { id: channelId },
      update: { channelName, description: "", archivedAt: null },
      create: { id: channelId, workspaceId, channelName, description: "" },
    });
    await db.conversationMember.upsert({
      where: { conversationId_userId: { conversationId: channelId, userId: DEV_BROWSER_USER.id } },
      update: { leftAt: null, channelRole: "admin", hiddenAt: null },
      create: {
        conversationId: channelId,
        workspaceId,
        userId: DEV_BROWSER_USER.id,
        channelRole: "admin",
      },
    });
    await mkdir(artifacts, { recursive: true });
    const channelPath = `${workspacePath}/channel/${channelId}`;

    await editor.browser("set", "viewport", "1440", "900");
    await editor.browser("open", `${origin}${channelPath}`);
    await editor.waitFor(
      `${pageHydrated} && ${channelHeader}?.querySelector("h1 [data-channel-name]")?.textContent === ${JSON.stringify(channelName)}`,
    );

    await watcher.browser("set", "viewport", "1440", "900");
    await watcher.browser("open", `${watcherProxy.origin}${channelPath}`);
    await watcher.waitFor(
      `${pageHydrated} && ${channelHeader}?.querySelector("h1 [data-channel-name]")?.textContent === ${JSON.stringify(channelName)} && ${sidebarHas(channelName)}`,
    );
    await watcherProxy.waitForSubscribed([
      conversationRealtimeChannel(channelId),
      workspaceConversationChannel(workspaceId),
    ]);

    // Watcher has confirmed Centrifugo subscriptions for both this channel and the workspace
    // sidebar; rename and describe in the editor tab and assert live delivery directly.
    await editor.browser("click", '[aria-label="Channel details and settings"]');
    await editor.waitFor(panelOpen);
    await editor.clickText(`${panelSelector} button`, "Edit");
    await editor.waitFor(`document.querySelector('${panelSelector} input[type="text"]') !== null`);
    await editor.browser("fill", `${panelSelector} input[type="text"]`, renamed);
    await editor.browser("fill", `${panelSelector} textarea`, "Followed live");
    await editor.waitFor(
      `!(${editor.byText(`${panelSelector} button`, "Save")}?.disabled ?? true)`,
    );
    await editor.clickText(`${panelSelector} button`, "Save");
    await editor.waitFor(
      `${channelHeader}?.querySelector("h1 [data-channel-name]")?.textContent === ${JSON.stringify(renamed)}`,
    );

    await watcher.waitFor(
      `${channelHeader}?.querySelector("h1 [data-channel-name]")?.textContent === ${JSON.stringify(renamed)}`,
    );
    await watcher.browser("click", '[aria-label="Channel details and settings"]');
    await watcher.waitFor(panelOpen);
    await watcher.waitFor(
      `document.querySelector('${panelSelector}')?.textContent.includes("Followed live")`,
    );
    await watcher.browser("press", "Escape");
    await watcher.waitFor(`document.querySelector('${panelSelector}') === null`);
    await watcher.waitFor(sidebarHas(renamed));
    expect(await watcher.evaluate<boolean>(sidebarHas(channelName))).toBe(false);
    await watcher.browser("screenshot", join(artifacts, "renamed.png"));

    // Archive in the editor tab: the watcher's composer turns into the archived notice and the
    // row leaves its sidebar.
    // It runs at once: Undo is in its toast (task #7).
    await editor.clickText("button", "Archive channel");
    await watcher.waitFor(`document.body.textContent.includes("This channel is archived.")`);
    await watcher.waitFor(`!${sidebarHas(renamed)}`);
    await watcher.browser("screenshot", join(artifacts, "archived.png"));

    // Unarchive from the editor's notice → panel: the watcher's composer comes back.
    await editor.waitFor(`document.body.textContent.includes("This channel is archived.")`);
    await editor.clickText("button", "Unarchive");
    await editor.waitFor(panelOpen);
    await editor.clickText("button", "Unarchive channel");
    await watcher.waitFor(`!document.body.textContent.includes("This channel is archived.")`);
    await watcher.waitFor(sidebarHas(renamed));
  } catch (error) {
    // Keep what each tab showed when it failed.
    await editor
      .browser("screenshot", join(artifacts, "failure-editor.png"))
      .catch(() => undefined);
    await watcher
      .browser("screenshot", join(artifacts, "failure-watcher.png"))
      .catch(() => undefined);
    throw error;
  } finally {
    await editor.browser("close").catch(() => undefined);
    await watcher.browser("close").catch(() => undefined);
    watcherProxy.stop();
    await db.$disconnect();
  }
}, 120_000);
