import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import {
  browserSession,
  escapeOpenMenu,
  localBrowserE2e,
  pageWaiter,
  seededUuid,
} from "./helpers/browser-e2e";

/**
 * The search dialog's filters in a real browser. From, Scope, Channel and Time narrow the results,
 * and each chip names its value. They live in the dialog only: an old `/search` address opens it
 * with its filters set.
 * A Scope that contradicts the sender drops the sender, and a sender that contradicts the Scope
 * drops that part of it. Filters search on their own without a query; Sort needs a query and
 * Recent orders newest first. Clear all resets every filter but keeps the sort.
 *
 * Opt-in like the other browser E2Es: real local Web + `agent-browser`. Seeds are deterministic
 * and reset on every run. Screenshots are written under `.amp/e2e/search-filters/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/search-filters");

test("search filters narrow results, name their values, and clear together", async () => {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl }),
  });
  const session = `search-filters-${process.pid}`;
  const { browser, evaluate } = browserSession(browserPath, session);
  const waitFor = pageWaiter(browserPath)(session, browser);
  const find = (selector: string, predicate: string) =>
    `[...document.querySelectorAll(${JSON.stringify(selector)})].find((element) => ${predicate})`;
  /** A filter chip: a button in the dialog's filter bar whose text starts with `prefix`. */
  const chip = (prefix: string) =>
    find(
      '[role="dialog"] [aria-label="Search filters"] button',
      `element.textContent.trim().startsWith(${JSON.stringify(prefix)})`,
    );
  /** The text a chip shows: the filter's name, or its chosen value. */
  const chipText = (prefix: string) => `${chip(prefix)}?.textContent.trim()`;
  const option = (text: string) =>
    find(
      '[role="menuitemradio"], [role="menuitemcheckbox"], [role="menuitem"]',
      // A person's row also shows an avatar initial before the name.
      `element.textContent.includes(${JSON.stringify(text)})`,
    );
  async function pick(chipPrefix: string, optionText: string) {
    await browser("eval", `${chip(chipPrefix)}.click()`);
    await waitFor(`${option(optionText)} !== undefined`);
    await browser("eval", `${option(optionText)}.click()`);
  }
  const resultIds = () =>
    evaluate<string[]>(
      `[...document.querySelectorAll('[role="dialog"] ol li [data-search-message-id]')].map((row) => row.dataset.searchMessageId)`,
    );
  /** Opens the dialog on an old search address; the box holds `phrase` once it is up. */
  async function openSearch(filters = "") {
    await browser(
      "open",
      `${origin}${workspacePath}/search?q=${encodeURIComponent(phrase)}${filters}`,
    );
    await waitFor(
      `document.querySelector('[role="dialog"] input[type="search"]')?.value === ${JSON.stringify(phrase)}`,
    );
  }
  /** Waits for a settled list of `count` rows; zero means the no-results state is showing. */
  const waitForResults = (count: number) =>
    waitFor(
      count === 0
        ? `/No results for|No matching messages/.test(document.querySelector('[role="dialog"]').textContent)`
        : `!document.querySelector('[role="dialog"] [aria-busy="true"]') && document.querySelectorAll('[role="dialog"] ol li [data-search-message-id]').length === ${count}`,
    );

  const channelA = seededUuid("e2e-search-filters:channel-a");
  const channelB = seededUuid("e2e-search-filters:channel-b");
  const agentId = seededUuid("e2e-search-filters:agent");
  const phrase = "筛选样本";
  /** Set once the dev user's Workspace is read. */
  let workspacePath = "";
  try {
    const membership = await db.workspaceMembership.findFirstOrThrow({
      where: { userId: DEV_BROWSER_USER.id },
      include: { workspace: { select: { slug: true } } },
    });
    workspacePath = `/en/w/${membership.workspace.slug}`;
    const workspaceId = membership.workspaceId;
    await db.conversation.deleteMany({
      where: { id: { in: [channelA, channelB] } },
    });
    await db.conversation.deleteMany({
      where: {
        workspaceId,
        channelName: { in: ["e2e-filter-a", "e2e-filter-b"] },
      },
    });
    await db.agent.upsert({
      where: { id: agentId },
      update: { deletedAt: null, visibility: "public" },
      create: {
        id: agentId,
        workspaceId,
        ownerId: DEV_BROWSER_USER.id,
        name: "e2e-search-bot",
        displayName: "Search Bot",
        runtimeConfig: {
          runtime: "claude-code",
          provider: { kind: "default" },
          model: "claude-opus-4-6",
          modelProvider: "",
          reasoning: "high",
        },
      },
    });
    await db.conversation.createMany({
      data: [
        {
          id: channelA,
          workspaceId,
          channelName: "e2e-filter-a",
          description: "",
        },
        {
          id: channelB,
          workspaceId,
          channelName: "e2e-filter-b",
          description: "",
        },
      ],
    });
    const human = await db.conversationMember.create({
      data: {
        conversationId: channelA,
        workspaceId,
        userId: DEV_BROWSER_USER.id,
      },
    });
    const botInA = await db.conversationMember.create({
      data: { conversationId: channelA, workspaceId, agentId },
    });
    const botInB = await db.conversationMember.create({
      data: { conversationId: channelB, workspaceId, agentId },
    });
    const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);
    const humanToday = await db.message.create({
      data: {
        conversationId: channelA,
        workspaceId,
        senderMemberId: human.id,
        // The newest and the longest body, so Relevant (which favours short, focused matches)
        // ranks it last while Recent ranks it first.
        body: `${phrase} from a human, in a message long enough that its match is a small part of it`,
        sequence: 2,
        createdAt: daysAgo(0),
      },
    });
    const agentOld = await db.message.create({
      data: {
        conversationId: channelA,
        workspaceId,
        senderMemberId: botInA.id,
        body: `<@human:${DEV_BROWSER_USER.id}> ${phrase} ten days ago`,
        sequence: 1,
        createdAt: daysAgo(10),
      },
    });
    await db.messageMention.create({
      data: {
        messageId: agentOld.id,
        memberId: human.id,
        conversationId: channelA,
        workspaceId,
        kind: "user",
        actorId: DEV_BROWSER_USER.id,
        handle: DEV_BROWSER_USER.username,
      },
    });
    const agentInB = await db.message.create({
      data: {
        conversationId: channelB,
        workspaceId,
        senderMemberId: botInB.id,
        body: `${phrase} in the second channel`,
        sequence: 1,
        createdAt: daysAgo(1),
      },
    });
    await mkdir(artifacts, { recursive: true });

    await browser("set", "viewport", "1440", "900");
    await openSearch();
    await waitForResults(3);
    // Sorting applies to a query; the chip starts on Relevant, which ranks the long newest last.
    expect(await evaluate<boolean>(`${chip("Sort")}.disabled`)).toBe(false);
    expect(await evaluate<string>(chipText("Sort"))).toBe("Sort: Relevant");
    expect((await resultIds()).at(-1)).toBe(humanToday.id);

    // From: only the chosen sender, named on the chip.
    await pick("From", "Search Bot");
    await waitFor(`${chipText("From")}?.startsWith("From: Search Bot")`);
    await waitForResults(2);
    expect((await resultIds()).sort()).toEqual([agentOld.id, agentInB.id].sort());
    await browser("screenshot", join(artifacts, "from.png"));

    // Scope Humans contradicts an Agent sender, so the sender goes.
    await pick("Scope", "Humans");
    await browser("eval", escapeOpenMenu);
    await waitFor(`document.querySelector('[role="menu"]') === null`);
    await waitFor(`${chipText("Scope")} === "Scope 1" && ${chipText("From")} === "From"`);
    await waitForResults(1);
    expect(await resultIds()).toEqual([humanToday.id]);

    // An Agent sender contradicts a Humans-only scope, so that part of the scope goes.
    await openSearch("&scope=mentioned,humans");
    await waitFor(`${chipText("Scope")} === "Scope 2"`);
    await waitForResults(0);
    await pick("From", "Search Bot");
    await waitFor(
      `${chipText("Scope")} === "Scope 1" && ${chipText("From")}?.startsWith("From: Search Bot")`,
    );
    await waitForResults(1);
    expect(await resultIds()).toEqual([agentOld.id]);

    // A sender the filters cannot name (gone from the Workspace) is dropped by a Humans-only
    // scope too, instead of leaving a search that can match nothing.
    const unknownSender = seededUuid("e2e-search-filters:unknown-sender");
    await openSearch(`&senderId=${unknownSender}`);
    await waitForResults(0);
    await pick("Scope", "Humans");
    await browser("eval", escapeOpenMenu);
    await waitFor(`document.querySelector('[role="menu"]') === null`);
    await waitFor(`${chipText("Scope")} === "Scope 1"`);
    await waitForResults(1);
    expect(await resultIds()).toEqual([humanToday.id]);

    // Recent orders newest first; the sort is kept by Clear all, every filter goes.
    await pick("Sort", "Recent");
    await waitFor(`${chipText("Sort")} === "Sort: Recent"`);
    await browser("eval", `${chip("Clear all")}.click()`);
    await waitFor(`${chipText("Scope")} === "Scope" && ${chipText("Sort")} === "Sort: Recent"`);
    await waitForResults(3);
    expect(await resultIds()).toEqual([humanToday.id, agentInB.id, agentOld.id]);

    // @ Me: only the message that mentions the viewer.
    await pick("Scope", "@ Me");
    await browser("eval", escapeOpenMenu);
    await waitFor(`document.querySelector('[role="menu"]') === null`);
    await waitFor(`${chipText("Scope")} === "Scope 1"`);
    await waitForResults(1);
    expect(await resultIds()).toEqual([agentOld.id]);
    await browser("eval", `${chip("Clear all")}.click()`);

    // Time: the last 7 days leave out the ten-day-old message; Today leaves out yesterday's.
    await pick("Time", "Last 7 days");
    await waitFor(`${chip("Last 7 days")} !== undefined`);
    await waitForResults(2);
    expect((await resultIds()).sort()).toEqual([humanToday.id, agentInB.id].sort());
    await pick("Last 7 days", "Today");
    await waitFor(`${chip("Today")} !== undefined`);
    await waitForResults(1);
    expect(await resultIds()).toEqual([humanToday.id]);

    // Every filter is named on its chip.
    await pick("Scope", "Humans");
    await browser("eval", escapeOpenMenu);
    await waitFor(`document.querySelector('[role="menu"]') === null`);
    await waitFor(
      `${chipText("Scope")} === "Scope 1" && ${chip("Today")} !== undefined && ${chip("Sort: Recent")} !== undefined`,
    );
    await waitForResults(1);
    await browser("eval", `${chip("Clear all")}.click()`);

    // Channel, then no query: the filter alone searches, and Sort waits for a query.
    // The row shows the channel's mark (`#` or a lock) as an icon, not in its text.
    await pick("Channel", "e2e-filter-b");
    await waitFor(
      `${find('[role="dialog"] [aria-label="Search filters"] button', 'element.textContent.includes("e2e-filter-b")')} !== undefined`,
    );
    await waitForResults(1);
    await browser(
      "eval",
      `(() => {
        const input = document.querySelector('[role="dialog"] input[type="search"]');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "");
        input.dispatchEvent(new InputEvent("input", { bubbles: true }));
      })()`,
    );
    await waitFor(`${chip("Sort")}.disabled === true`);
    await waitForResults(1);
    expect(await resultIds()).toEqual([agentInB.id]);
    await browser("screenshot", join(artifacts, "filter-only.png"));
  } finally {
    await browser("close").catch(() => undefined);
    await db.conversation
      .deleteMany({ where: { id: { in: [channelA, channelB] } } })
      .catch(() => {});
    await db.agent
      .update({ where: { id: agentId }, data: { deletedAt: new Date() } })
      .catch(() => {});
    await db.$disconnect();
  }
}, 240_000);
