import { test } from "bun:test";
import { peopleDirectKey } from "#src/features/conversations/direct-key";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { pageHydrated } from "./helpers/browser-e2e";
import { hideUsernamesRun } from "./helpers/hide-usernames-e2e";

/**
 * A channel's members page (roster and add view) lists people by their names and does not show,
 * or search by, their usernames. The Search page's From filter and its Frequently used direct
 * message name people the same way, while an Agent keeps its `@handle`. Settings and the Members
 * directory: `e2e-hide-usernames.e2e.ts`.
 *
 * Opt-in like the other browser E2Es: real local Web (`COFORGE_DEV_SKIP_AUTH=1`) + `agent-browser`
 * against the dev database, seeded by `hideUsernamesRun`.
 */
test(
  "channel members and Search show people by their names, never a username",
  () =>
    hideUsernamesRun(
      "channels",
      async ({
        browser,
        evaluate,
        waitFor,
        db,
        workspaceId,
        base,
        uid,
        people,
        showsNoUsername,
        hydrated,
        check,
        shoot,
      }) => {
        let text: string;
        // A channel with the viewer (its admin), Ada and Grace; Lin is a Workspace member outside it.
        const { id: channelId } = await db.conversation.create({
          data: {
            workspaceId,
            channelName: "hide-team",
            description: "",
            members: {
              create: [
                { userId: DEV_BROWSER_USER.id, channelRole: "admin" },
                { userId: people[0]!.id },
                { userId: people[1]!.id },
              ],
            },
          },
        });
        // A channel's members page: the roster and the add view search names, not usernames.
        await browser("open", `${base}/channel/${channelId}`);
        await waitFor(
          `document.querySelector('[aria-label="Channel Details and Settings"]') !== null`,
        );
        const panel = `document.querySelector('[role="dialog"][aria-label="Channel Details and Settings"]')`;
        const panelText = () => evaluate<string>(`${panel}?.innerText ?? ""`);
        const roster = `${panel}?.querySelector('input[placeholder="Search members…"]') != null`;
        // A click that lands before the page hydrates opens nothing; try again until the panel opens.
        await waitFor(pageHydrated);
        for (let attempt = 0; ; attempt += 1) {
          await browser("click", '[aria-label="Channel Details and Settings"]');
          const opened = await waitFor(`${panel} !== null`).then(
            () => true,
            () => false,
          );
          if (opened) break;
          if (attempt === 5) throw new Error("the channel settings panel never opened");
        }
        await browser(
          "eval",
          `[...${panel}.querySelectorAll("button")].find((button) => /3 humans/.test(button.textContent)).click()`,
        );
        await waitFor(roster);
        await waitFor(`${panel}.innerText.includes("Ada Lovelace")`);
        text = await panelText();
        for (const name of ["Ada Lovelace", "Amazing Grace", "Dev Viewer"])
          check(`channel roster: lists ${name}`, text.includes(name));
        check("channel roster: shows no username", showsNoUsername(text));
        check("channel roster: no row carries an @handle", !/@[a-z0-9-]/i.test(text));
        check(
          "channel roster: the viewer's own row offers no role change, another member's does",
          await evaluate<boolean>(
            `${panel}.querySelector('[aria-label="Make Ada Lovelace a channel admin"]') !== null && ${panel}.querySelector('[aria-label="Make Dev Viewer a channel admin"], [aria-label="Remove channel admin from Dev Viewer"]') === null`,
          ),
        );
        await shoot("channel-roster");
        const search = async (query: string) => {
          await browser("fill", 'input[placeholder="Search members…"]', query);
          await waitFor(
            query.includes("zq7k")
              ? `${panel}.innerText.includes("No members match")`
              : `!${panel}.innerText.includes("No members match") && ${panel}.querySelectorAll('[aria-label^="Make "]').length <= 1`,
          );
          return panelText();
        };
        text = await search("lovelace");
        check(
          "channel roster: a person is found by their name",
          text.includes("Ada Lovelace") && !text.includes("Amazing Grace"),
        );
        text = await search("zq7k");
        check("channel roster: a username finds nobody", /No members match/.test(text));

        // The add view offers Lin, who is in the Workspace and not in the channel.
        await browser("fill", 'input[placeholder="Search members…"]', "");
        await browser(
          "eval",
          `[...${panel}.querySelectorAll("button")].find((button) => button.textContent.trim() === "Add Member").click()`,
        );
        await waitFor(`${panel}.innerText.includes("Add Selected (0)")`);
        await waitFor(`${panel}.innerText.includes("Lindy")`);
        text = await panelText();
        check("channel add view: lists the person by label", text.includes("Lindy"));
        check("channel add view: shows no username", showsNoUsername(text));
        // An Agent keeps its `@handle` after its name, as in every picker; a person's row has none.
        const lindyRow = await evaluate<string>(
          `[...${panel}.querySelectorAll("li")].find((row) => row.innerText.includes("Lindy"))?.innerText ?? ""`,
        );
        check("channel add view: a person's row carries no @handle", !lindyRow.includes("@"));
        await shoot("channel-add-view");
        await browser("fill", 'input[placeholder="Name"]', "lind");
        await waitFor(`${panel}.innerText.includes("Lindy")`);
        check(
          "channel add view: a person is found by their name",
          (await panelText()).includes("Lindy"),
        );
        await browser("fill", 'input[placeholder="Name"]', "zq7k");
        await waitFor(`${panel}.innerText.includes("No members match")`);
        check("channel add view: a username finds nobody", !(await panelText()).includes("Lindy"));

        // Search: the From filter and a remembered direct message name people by their names alone;
        // an Agent keeps its `@handle`, which is how it is mentioned.
        const agentHandle = `e2e-hide-bot-${uid}`;
        const agent = await db.agent.create({
          data: {
            workspaceId,
            ownerId: DEV_BROWSER_USER.id,
            name: agentHandle,
            displayName: "Hide Bot",
            runtimeConfig: {
              runtime: "claude-code",
              provider: { kind: "default" },
              model: "claude-opus-4-6",
              modelProvider: "",
              reasoning: "high",
            },
          },
        });
        const direct = await db.conversation.create({
          data: { workspaceId, directKey: peopleDirectKey(DEV_BROWSER_USER.id, people[0]!.id) },
        });
        await db.conversationMember.createMany({
          data: [DEV_BROWSER_USER.id, people[0]!.id].map((userId) => ({
            conversationId: direct.id,
            workspaceId,
            userId,
          })),
        });
        const usageKey = `coforge:search-usage:${workspaceId}:${DEV_BROWSER_USER.id}`;
        const usage = {
          [`dm:${direct.id}`]: [Date.now() - 1000],
          [`agent:${agent.id}`]: [Date.now() - 2000],
        };
        await browser("open", `${base}/search`);
        await browser(
          "eval",
          `localStorage.clear(); localStorage.setItem(${JSON.stringify(usageKey)}, ${JSON.stringify(JSON.stringify(usage))})`,
        );
        await browser("open", `${base}/search`);
        const frequent = '[aria-labelledby="search-frequent-heading"] [data-search-entity]';
        await waitFor(`document.querySelectorAll(${JSON.stringify(frequent)}).length === 2`);
        const cards = await evaluate<Record<string, string>>(
          `Object.fromEntries([...document.querySelectorAll(${JSON.stringify(frequent)})].map((card) => [card.dataset.searchEntity, card.innerText]))`,
        );
        const dmCard = cards[`dm:${direct.id}`] ?? "";
        check(
          "search home: a direct message card is named by the person",
          dmCard.includes("Ada Lovelace"),
        );
        check(
          "search home: a direct message card shows no username or @handle",
          showsNoUsername(dmCard) && !dmCard.includes("@"),
        );
        check(
          "search home: an Agent card keeps its @handle",
          (cards[`agent:${agent.id}`] ?? "").includes(`@${agentHandle}`),
        );
        await shoot("search-home");

        // The From filter lists people by name with no addon, and finds them by name only.
        const fromChip = `[...document.querySelectorAll('[aria-label="Search filters"] button')].find((button) => button.textContent.trim().startsWith("From"))`;
        await waitFor(hydrated(fromChip));
        await browser("eval", `${fromChip}.click()`);
        const fromField = 'input[placeholder="Find a person or Agent"]';
        const fromOptions = () =>
          evaluate<string[]>(
            `[...document.querySelectorAll('[role="menuitemradio"], [role="menuitem"]')].map((item) => item.textContent.trim())`,
          );
        await waitFor(`document.querySelectorAll('[role="menuitemradio"]').length >= 5`);
        let options = await fromOptions();
        for (const name of ["Ada Lovelace", "Amazing Grace", "Lindy", "Hide Bot"])
          check(
            `from filter: lists ${name}`,
            options.some((option) => option.includes(name)),
          );
        // A row is an avatar initial, then the name, then an addon: the Agents' `@handle`.
        const personRows = options.filter((option) =>
          /Ada Lovelace|Amazing Grace|Lindy|Me$/.test(option),
        );
        check("from filter: shows no username", showsNoUsername(options.join(" ")));
        check(
          "from filter: a person's row carries no @handle",
          personRows.length === 4 && personRows.every((option) => !option.includes("@")),
        );
        check(
          "from filter: an Agent keeps its @handle",
          options.some((option) => option.includes(`@${agentHandle}`)),
        );
        await shoot("search-from-filter");
        const findSender = async (query: string) => {
          await browser("fill", fromField, query);
          // The list filters as it is typed; wait for it to settle on the expected rows.
          await new Promise((resolve) => setTimeout(resolve, 400));
          return fromOptions();
        };
        options = await findSender("lovelace");
        check(
          "from filter: a person is found by their name",
          options.some((option) => option.includes("Ada Lovelace")) &&
            !options.some((option) => option.includes("Amazing Grace")),
        );
        options = await findSender("zq7k");
        check(
          "from filter: a username finds nobody",
          !options.some((option) => /Ada|Grace|Lindy|Me/.test(option)),
        );
        options = await findSender("bot");
        check(
          "from filter: an Agent is found by its handle too",
          options.some((option) => option.includes("Hide Bot")),
        );
        await browser("press", "Escape");

        // A username typed into the search box names no person or place.
        await browser("open", `${base}/search?q=zq7k`);
        await waitFor(`document.querySelector("main")?.innerText.includes("zq7k")`);
        await waitFor(`!document.querySelector('[aria-busy="true"]')`);
        const entityCards = await evaluate<string[]>(
          `[...document.querySelectorAll("main [data-search-entity]")].map((card) => card.dataset.searchEntity)`,
        );
        check(
          "search: a username matches no person, direct message or place",
          entityCards.length === 0,
        );
      },
    ),
  180_000,
);
