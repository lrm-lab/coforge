import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { browserSession, localBrowserE2e, pageWaiter, seededUuid } from "./helpers/browser-e2e";

/**
 * The search dialog's filters in a real browser. From, Scope, Channel and Time narrow the results.
 * Time, Scope and Sort are one press each and show what is chosen; From and Channel are rows that
 * name their value. They live in the dialog only: an old `/search` address opens it
 * with its filters set.
 * A Scope that contradicts the sender drops the sender, and a sender that contradicts the Scope
 * drops that part of it. Filters search on their own without a query; Sort needs a query and
 * Recent orders newest first. Each chip under the box removes its own filter.
 *
 * Opt-in like the other browser E2Es: real local Web + `agent-browser`. Seeds are deterministic
 * and reset on every run. Screenshots are written under `.amp/e2e/search-filters/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/search-filters");

test("search filters narrow results, name their values, and come off one by one", async () => {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl }),
  });
  const session = `search-filters-${process.pid}`;
  const { browser, evaluate } = browserSession(browserPath, session);
  const waitFor = pageWaiter(browserPath)(session, browser);
  const find = (selector: string, predicate: string) =>
    `[...document.querySelectorAll(${JSON.stringify(selector)})].find((element) => ${predicate})`;
  /** A filter row or button in the filter popover whose text starts with `prefix`. */
  const chip = (prefix: string) =>
    find(
      "[data-search-filter-menu] button",
      `element.textContent.trim().startsWith(${JSON.stringify(prefix)})`,
    );
  /** The text a row shows: the filter's name, or its chosen value. */
  const chipText = (prefix: string) => `${chip(prefix)}?.textContent.trim()`;
  const option = (text: string) =>
    find(
      '[role="menuitemradio"], [role="menuitemcheckbox"], [role="menuitem"]',
      // A person's row also shows an avatar initial before the name.
      `element.textContent.includes(${JSON.stringify(text)})`,
    );
  /** One choice of a one-press filter (Time, Scope, Sort). */
  const choice = (group: string, label: string) =>
    find(
      `[data-search-filter-menu] [aria-label="${group}"] button`,
      `element.textContent.trim() === ${JSON.stringify(label)}`,
    );
  /** What a one-press filter has chosen, in its order, as JSON. */
  const chosen = (group: string) =>
    `JSON.stringify([...document.querySelectorAll('[data-search-filter-menu] [aria-label="${group}"] button')].filter((button) => button.getAttribute("aria-checked") === "true" || button.getAttribute("aria-pressed") === "true").map((button) => button.textContent.trim()))`;
  const isChosen = (group: string, labels: string[]) =>
    `${chosen(group)} === ${JSON.stringify(JSON.stringify(labels))}`;
  const press = (group: string, label: string) =>
    browser("eval", `${choice(group, label)}.click()`);
  /** Removes a filter by its chip under the box. */
  const unchip = (name: string) =>
    browser("eval", `document.querySelector('[aria-label="Remove filter ${name}"]').click()`);
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
    await browser("click", '[aria-label="Filter results"]');
    await waitFor(`${choice("Sort", "Relevant")} !== undefined`);
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
      // Other e2es leave the dev user in Workspaces of their own; the seed made the first one.
      orderBy: { workspace: { createdAt: "asc" } },
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
    // An earlier run may have left this Agent in another Workspace, with memberships there that
    // cannot move along: remove it so it is made afresh here.
    await db.agent.deleteMany({ where: { id: agentId, workspaceId: { not: workspaceId } } });
    await db.agent.upsert({
      where: { id: agentId },
      update: { deletedAt: null, visibility: "public", workspaceId, ownerId: DEV_BROWSER_USER.id },
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
    // Sorting applies to a query; it starts on Relevant, which ranks the long newest last.
    expect(await evaluate<boolean>(`${choice("Sort", "Recent")}.disabled`)).toBe(false);
    await waitFor(isChosen("Sort", ["Relevant"]));
    expect((await resultIds()).at(-1)).toBe(humanToday.id);

    // From: only the chosen sender, named on its row.
    await pick("From", "Search Bot");
    await waitFor(`${chipText("From")}?.includes("Search Bot")`);
    await waitForResults(2);
    expect((await resultIds()).sort()).toEqual([agentOld.id, agentInB.id].sort());
    await browser("screenshot", join(artifacts, "from.png"));

    // Scope Humans contradicts an Agent sender, so the sender goes.
    await press("Scope", "Humans");
    await waitFor(`${isChosen("Scope", ["Humans"])} && ${chipText("From")} === "FromAnyone"`);
    await waitForResults(1);
    expect(await resultIds()).toEqual([humanToday.id]);

    // An Agent sender contradicts a Humans-only scope, so that part of the scope goes.
    await openSearch("&scope=mentioned,humans");
    await waitFor(isChosen("Scope", ["@ Me", "Humans"]));
    await waitForResults(0);
    await pick("From", "Search Bot");
    await waitFor(`${isChosen("Scope", ["@ Me"])} && ${chipText("From")}?.includes("Search Bot")`);
    await waitForResults(1);
    expect(await resultIds()).toEqual([agentOld.id]);

    // A sender the filters cannot name (gone from the Workspace) is dropped by a Humans-only
    // scope too, instead of leaving a search that can match nothing.
    const unknownSender = seededUuid("e2e-search-filters:unknown-sender");
    await openSearch(`&senderId=${unknownSender}`);
    await waitForResults(0);
    await press("Scope", "Humans");
    await waitFor(isChosen("Scope", ["Humans"]));
    await waitForResults(1);
    expect(await resultIds()).toEqual([humanToday.id]);

    // Recent orders newest first; removing the scope's chip keeps the sort.
    await press("Sort", "Recent");
    await waitFor(isChosen("Sort", ["Recent"]));
    await unchip("Humans");
    await waitFor(`${isChosen("Scope", ["All"])} && ${isChosen("Sort", ["Recent"])}`);
    await waitForResults(3);
    expect(await resultIds()).toEqual([humanToday.id, agentInB.id, agentOld.id]);

    // @ Me: only the message that mentions the viewer.
    await press("Scope", "@ Me");
    await waitFor(isChosen("Scope", ["@ Me"]));
    await waitForResults(1);
    expect(await resultIds()).toEqual([agentOld.id]);
    await unchip("@ Me");

    // Time: the last 7 days leave out the ten-day-old message; Today leaves out yesterday's.
    await press("Time", "Last 7 days");
    await waitFor(isChosen("Time", ["Last 7 days"]));
    await waitForResults(2);
    expect((await resultIds()).sort()).toEqual([humanToday.id, agentInB.id].sort());
    await press("Time", "Today");
    await waitFor(isChosen("Time", ["Today"]));
    await waitForResults(1);
    expect(await resultIds()).toEqual([humanToday.id]);

    // Every one-press filter shows what it has chosen.
    await press("Scope", "Humans");
    await waitFor(
      `${isChosen("Scope", ["Humans"])} && ${isChosen("Time", ["Today"])} && ${isChosen("Sort", ["Recent"])}`,
    );
    await browser("screenshot", join(artifacts, "filters-chosen.png"));
    await waitForResults(1);
    await unchip("Humans");
    await unchip("Today");

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
    await waitFor(`${choice("Sort", "Recent")}.disabled === true`);
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
