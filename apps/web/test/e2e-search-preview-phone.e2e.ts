import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { browserSession, hydrated, seededUuid } from "./helpers/browser-e2e";

/**
 * Search on a phone, in a real browser: there is no room beside the results, so a click opens the
 * result's conversation full-screen in their place, still on Search. Opening it is a step in
 * history: the header's back arrow (also after a reload) and the back gesture return to the
 * results, the query kept.
 *
 * Opt-in like the other browser E2Es: real local Web + `agent-browser`. The channel and its
 * messages are seeded deterministically and reset on every run. A screenshot of a result open
 * (`phone-open.png`) is written under `.amp/e2e/search-preview/`.
 */
const origin = Bun.env.COFORGE_E2E_WEB_URL;
if (!origin || !["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  throw new Error("COFORGE_E2E_WEB_URL must target the local Web service");
const browserPath = Bun.which("agent-browser");
if (!browserPath) throw new Error("agent-browser is required");
const databaseUrl = Bun.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1")
  throw new Error("DATABASE_URL must target local PostgreSQL");
const artifacts = join(import.meta.dir, "../../../.amp/e2e/search-preview");

test("on a phone a result opens its conversation in place of the results", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `search-preview-phone-${process.pid}`);
  const channelId = seededUuid("e2e-search-preview:phone-channel");
  const phrase = "手机预览样本";
  const row = (id: string) => `[data-search-message-id="${id}"]`;
  try {
    const membership = await db.workspaceMembership.findFirstOrThrow({
      where: { userId: DEV_BROWSER_USER.id },
      include: { workspace: { select: { slug: true } } },
    });
    const workspacePath = `/en/w/${membership.workspace.slug}`;
    const workspaceId = membership.workspaceId;
    await db.conversation.deleteMany({ where: { id: channelId } });
    await db.conversation.create({
      data: { id: channelId, workspaceId, channelName: "e2e-preview-phone", description: "" },
    });
    const member = await db.conversationMember.create({
      data: { conversationId: channelId, workspaceId, userId: DEV_BROWSER_USER.id },
    });
    const match = await db.message.create({
      data: {
        conversationId: channelId,
        workspaceId,
        senderMemberId: member.id,
        body: `${phrase} on a phone`,
        sequence: 1,
      },
    });

    await browser("set", "viewport", "390", "844");
    await browser("open", `${origin}${workspacePath}/search?q=${encodeURIComponent(phrase)}`);
    await browser(
      "wait",
      "--fn",
      `document.querySelector('${row(match.id)}') !== null && ${hydrated}`,
    );
    await mkdir(artifacts, { recursive: true });
    const preview = `document.querySelector('[aria-label="Search preview"]')`;
    const resultShown = `document.querySelector('${row(match.id)}')?.getClientRects().length > 0`;
    const resultsAlone = `${preview} === null && ${resultShown} && new URLSearchParams(location.search).get("open") === null && new URLSearchParams(location.search).get("q") === ${JSON.stringify(phrase)}`;
    const entry = () => evaluate<number>("navigation.currentEntry.index");
    const listEntry = await entry();
    /** Opens the result: its conversation in place of the results, a step in history. */
    const open = async () => {
      await browser("click", row(match.id));
      await browser(
        "wait",
        "--fn",
        `new URLSearchParams(location.search).get("open") === "channel:${channelId}" && ${preview}?.querySelector('li[data-message-id="${match.id}"]') !== null && !(${resultShown})`,
      );
      expect(await evaluate<string>("location.pathname")).toBe(`${workspacePath}/search`);
      expect(await entry()).toBe(listEntry + 1);
    };
    await open();
    await browser("screenshot", join(artifacts, "phone-open.png"));
    await browser("find", "role", "button", "click", "--name", "Back to results");
    await browser("wait", "--fn", resultsAlone);
    expect(await entry()).toBe(listEntry);
    // The back gesture returns to the results too.
    await open();
    await browser("back");
    await browser("wait", "--fn", resultsAlone);
    // A reload keeps the arrow's way back to the results' entry.
    await open();
    await browser("reload");
    await browser(
      "wait",
      "--fn",
      `${preview}?.querySelector('li[data-message-id="${match.id}"]') !== null && ${hydrated}`,
    );
    await browser("find", "role", "button", "click", "--name", "Back to results");
    await browser("wait", "--fn", resultsAlone);
    expect(await entry()).toBe(listEntry);
  } finally {
    await browser("close").catch(() => undefined);
    await db.conversation.deleteMany({ where: { id: channelId } }).catch(() => {});
    await db.$disconnect();
  }
}, 90_000);
