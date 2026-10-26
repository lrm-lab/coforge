import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { browserSession, localBrowserE2e, pageHydrated, seededUuid } from "./helpers/browser-e2e";

/**
 * Search on a phone, in a real browser: there is no room beside the results, so a click opens the
 * result's conversation full-screen in their place, still on Search. Opening it is a step in
 * history: the header's back arrow (also after a reload), the back gesture and Cmd/Ctrl+K return
 * to the results, the query kept, Cmd/Ctrl+K with its box focused. Beside the results, closing a
 * preview (Esc) keeps the search it was opened from, whatever search is behind it in history. A
 * conversation that cannot be loaded says so under the back arrow, with no empty bar above it
 * once the results sit beside it.
 *
 * Opt-in like the other browser E2Es: real local Web + `agent-browser`. The channel and its
 * messages are seeded deterministically and reset on every run. A screenshot of a result open
 * (`phone-open.png`) is written under `.amp/e2e/search-preview/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/search-preview");

test("on a phone a result opens its conversation in place of the results", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `search-preview-phone-${process.pid}`);
  const channelId = seededUuid("e2e-search-preview:phone-channel");
  // A second match whose conversation the run never opens, so nothing of it is cached.
  const unopenedId = seededUuid("e2e-search-preview:phone-unopened");
  const phrase = "手机预览样本";
  const row = (id: string) => `[data-search-message-id="${id}"]`;
  try {
    const membership = await db.workspaceMembership.findFirstOrThrow({
      where: { userId: DEV_BROWSER_USER.id },
      include: { workspace: { select: { slug: true } } },
    });
    const workspacePath = `/en/w/${membership.workspace.slug}`;
    const workspaceId = membership.workspaceId;
    /** A channel the viewer is in, with one message the search matches. */
    const seedMatch = async (id: string, channelName: string, body: string) => {
      await db.conversation.deleteMany({ where: { id } });
      await db.conversation.create({ data: { id, workspaceId, channelName, description: "" } });
      const member = await db.conversationMember.create({
        data: { conversationId: id, workspaceId, userId: DEV_BROWSER_USER.id },
      });
      return db.message.create({
        data: { conversationId: id, workspaceId, senderMemberId: member.id, body, sequence: 1 },
      });
    };
    const match = await seedMatch(channelId, "e2e-preview-phone", `${phrase} on a phone`);
    const unopened = await seedMatch(
      unopenedId,
      "e2e-preview-phone-unopened",
      `${phrase} never opened`,
    );

    await browser("set", "viewport", "390", "844");
    await browser("open", `${origin}${workspacePath}/search?q=${encodeURIComponent(phrase)}`);
    await browser(
      "wait",
      "--fn",
      `document.querySelector('${row(match.id)}') !== null && ${pageHydrated}`,
    );
    await mkdir(artifacts, { recursive: true });
    const preview = `document.querySelector('[aria-label="Search preview"]')`;
    const resultShown = `document.querySelector('${row(match.id)}')?.getClientRects().length > 0`;
    const resultsAlone = `${preview} === null && ${resultShown} && new URLSearchParams(location.search).get("open") === null && new URLSearchParams(location.search).get("q") === ${JSON.stringify(phrase)}`;
    const entry = () => evaluate<number>("navigation.currentEntry.index");
    let listEntry = await entry();
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
    // A query typed just before a tap waits for the results to show again, rather than rewriting
    // the preview's entry, so the arrow still goes back to the results' entry; it commits there.
    const typed = `${phrase} 补充`;
    await evaluate(`(() => {
      const box = document.querySelector('input[type="search"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(box, ${JSON.stringify(typed)});
      box.dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelector('${row(match.id)}').click();
      return true;
    })()`);
    await browser("wait", "--fn", `${preview} !== null`);
    await Bun.sleep(400);
    await browser("find", "role", "button", "click", "--name", "Back to results");
    await browser(
      "wait",
      "--fn",
      `${preview} === null && new URLSearchParams(location.search).get("q") === ${JSON.stringify(typed)}`,
    );
    expect(await entry()).toBe(listEntry);
    await browser("back");
    await browser(
      "wait",
      "--fn",
      `new URLSearchParams(location.search).get("q") !== ${JSON.stringify(typed)}`,
    );
    await browser("open", `${origin}${workspacePath}/search?q=${encodeURIComponent(phrase)}`);
    await browser("wait", "--fn", `${resultShown} && ${pageHydrated}`);
    listEntry = await entry();
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
      `${preview}?.querySelector('li[data-message-id="${match.id}"]') !== null && ${pageHydrated}`,
    );
    await browser("find", "role", "button", "click", "--name", "Back to results");
    await browser("wait", "--fn", resultsAlone);
    expect(await entry()).toBe(listEntry);
    // Cmd/Ctrl+K focuses the search box, which a result open in the results' place hides: the
    // results come back first.
    await open();
    await browser("press", "Meta+k");
    const box = `document.querySelector('input[type="search"]')`;
    await browser("wait", "--fn", `${resultsAlone} && document.activeElement === ${box}`);
    expect(await entry()).toBe(listEntry);

    // Beside the results a preview replaces the entry, so Esc closing it keeps this search, not
    // the earlier one behind it.
    await browser("set", "viewport", "1024", "800");
    await browser("open", `${origin}${workspacePath}/search?q=${encodeURIComponent("earlier")}`);
    await browser("open", `${origin}${workspacePath}/search?q=${encodeURIComponent(phrase)}`);
    await browser("wait", "--fn", `${resultShown} && ${pageHydrated}`);
    const searchEntry = await entry();
    await browser("click", row(match.id));
    await browser(
      "wait",
      "--fn",
      `${preview}?.querySelector('li[data-message-id="${match.id}"]') != null`,
    );
    // Esc in the conversation is its own (its composer has focus): press it from the results.
    await evaluate(`document.querySelector('${row(match.id)}').focus() ?? true`);
    await browser("press", "Escape");
    await browser("wait", "--fn", `${preview} === null`);
    expect(await evaluate<string | null>(`new URLSearchParams(location.search).get("q")`)).toBe(
      phrase,
    );
    expect(await entry()).toBe(searchEntry);
    await browser("set", "viewport", "390", "844");

    // A conversation that cannot be loaded says so, under its back arrow; beside the results,
    // where there is no arrow, no empty bar is left above the failure.
    await browser("network", "route", `${origin}/_serverFn/*`, "--abort");
    await browser("click", row(unopened.id));
    const failure = `${preview}?.querySelector('[role="alert"]')`;
    await browser("wait", "--fn", `${failure} != null`);
    const failureHeader = `${preview}.querySelector("header")`;
    expect(await evaluate<boolean>(`${failureHeader}?.getClientRects().length > 0`)).toBe(true);
    await browser("set", "viewport", "1024", "800");
    await browser("wait", "--fn", `${resultShown} && ${failure} != null`);
    expect(
      await evaluate<boolean>(
        `${failureHeader} === null || ${failureHeader}.getClientRects().length === 0`,
      ),
    ).toBe(true);
  } finally {
    await browser("network", "unroute").catch(() => undefined);
    await browser("close").catch(() => undefined);
    await db.conversation
      .deleteMany({ where: { id: { in: [channelId, unopenedId] } } })
      .catch(() => {});
    await db.$disconnect();
  }
}, 90_000);
