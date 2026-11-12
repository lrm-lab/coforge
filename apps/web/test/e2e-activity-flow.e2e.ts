import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import {
  browserSession,
  devBrowserWorkspace,
  localBrowserE2e,
  pageHydrated,
} from "./helpers/browser-e2e";
import { openParam, rowItems } from "./helpers/activity-inbox-e2e";
import { seedActivityKeys } from "./helpers/activity-keys-seed";

/**
 * Activity run from the keyboard with a conversation open beside the list (Frank, 11-12): the
 * open conversation follows the selection, E marks the open row Done and opens the next, the
 * pane's composer leaves the caret in the list, Enter puts it in the composer and Escape gives it
 * back (after closing a completion popup first), and a hint over the composer names the keys
 * (J K and E; Esc while typing). Keys pressed in quick succession do not open the rows they pass,
 * j pressed in the conversation outside a field still moves the list, and any other character
 * typed outside a field starts a message there, as in Slack.
 *
 * Opt-in like the other browser E2Es: real local Web + `agent-browser`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();

test("the open conversation follows the Activity list's selection", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate, waitFor } = browserSession(
    browserPath,
    `activity-flow-${process.pid}`,
  );
  const rows = `[...document.querySelectorAll(${rowItems})]`;
  const seeded = `${rows}.filter((row) => row.textContent.includes("e2e-keys"))`;
  // Rows go by their key: a row's text changes as it is read.
  const keyOf = (row: string) => `${row}?.getAttribute("data-activity-row") ?? null`;
  /** The row holding focus, or null. */
  const focusedKey = keyOf(`${rows}.find((row) => row.contains(document.activeElement))`);
  /** The row standing for the open conversation, or null. */
  const currentKey = keyOf(
    `${rows}.find((row) => row.querySelector("a")?.getAttribute("aria-current") === "true")`,
  );
  const hint = `(document.querySelector("[data-activity-flow-hint]")?.textContent ?? "")`;
  const typing = `document.activeElement?.matches("[data-composer]") ?? false`;
  // The conversation a row opened has loaded far enough to take a message.
  const composerShown = `document.querySelector("[aria-label='Selected conversation'] [data-composer]") !== null`;
  try {
    const { workspace, workspaceId } = await devBrowserWorkspace(db);
    await seedActivityKeys(db, workspaceId);
    await browser("set", "viewport", "1440", "900");
    await browser("open", `${origin}/en/w/${workspace.slug}/activity`);
    await waitFor(`${seeded}.length === 4 && ${pageHydrated}`, 40_000);
    // Let the first reads and the realtime join settle: a refresh then would not move focus.
    await Bun.sleep(2_000);

    // Enter opens the selected row; the list keeps the caret, its composer does not take it.
    const first = await evaluate<string>(keyOf(`${seeded}[0]`));
    await evaluate(`(${seeded}[0].querySelector("a").focus(), true)`);
    await browser("press", "Enter");
    await waitFor(`${openParam} !== null`);
    await Bun.sleep(1_000);
    expect(await evaluate<string | null>(focusedKey)).toBe(first);
    expect(await evaluate<boolean>(typing)).toBe(false);
    await waitFor(`${hint}.includes("J") && ${hint}.includes("K") && ${hint}.includes("E")`);

    // Down opens the row it moves to, and the list keeps the caret.
    const firstOpen = await evaluate<string>(openParam);
    const second = await evaluate<string>(keyOf(`${seeded}[1]`));
    await browser("press", "j");
    await waitFor(`${openParam} !== ${JSON.stringify(firstOpen)}`);
    expect(await evaluate<string | null>(focusedKey)).toBe(second);
    await waitFor(`${currentKey} === ${JSON.stringify(second)}`);
    expect(await evaluate<boolean>(typing)).toBe(false);

    // E marks the open row Done: it leaves, and the row after it opens.
    const secondOpen = await evaluate<string>(openParam);
    const third = await evaluate<string>(keyOf(`${seeded}[2]`));
    await browser("press", "e");
    await waitFor(
      `!${rows}.some((row) => row.getAttribute("data-activity-row") === ${JSON.stringify(second)})`,
    );
    await waitFor(`${openParam} !== ${JSON.stringify(secondOpen)}`);
    await waitFor(`${currentKey} === ${JSON.stringify(third)}`);
    expect(await evaluate<string | null>(focusedKey)).toBe(third);

    // Enter on the open row puts the caret in its composer, where j is only a letter; the hint
    // then names Escape. Escape closes the completion popup first, then gives the caret back to
    // the row without closing the conversation.
    const thirdOpen = await evaluate<string>(openParam);
    await waitFor(composerShown);
    await browser("press", "Enter");
    await waitFor(typing);
    await waitFor(`${hint}.includes("Esc")`);
    await browser("keyboard", "type", "j @");
    await waitFor(`document.querySelector('[role="listbox"]') !== null`);
    expect(await evaluate<string>(openParam)).toBe(thirdOpen);
    await browser("press", "Escape");
    await waitFor(`document.querySelector('[role="listbox"]') === null`);
    expect(await evaluate<boolean>(typing)).toBe(true);
    await browser("press", "Escape");
    await waitFor(`${focusedKey} === ${JSON.stringify(third)}`);
    expect(await evaluate<string>(openParam)).toBe(thirdOpen);

    // Down and straight back up, as a held key passes rows: the row passed does not open.
    await evaluate(
      `(["j", "k"].forEach((key) => document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, repeat: true }))), true)`,
    );
    await Bun.sleep(1_000);
    expect(await evaluate<string>(openParam)).toBe(thirdOpen);
    expect(await evaluate<string | null>(focusedKey)).toBe(third);

    // j pressed in the conversation, outside its composer, moves the list and opens the next row.
    const fourth = await evaluate<string>(
      keyOf(
        `${rows}[${rows}.findIndex((row) => row.getAttribute("data-activity-row") === ${JSON.stringify(third)}) + 1]`,
      ),
    );
    const paneButton = `[...document.querySelectorAll("[aria-label='Selected conversation'] button")].some((button) => (button.focus(), document.activeElement === button))`;
    expect(await evaluate<boolean>(paneButton)).toBe(true);
    expect(await evaluate<string | null>(focusedKey)).toBe(null);
    await browser("press", "j");
    await waitFor(`${openParam} !== ${JSON.stringify(thirdOpen)}`);
    expect(await evaluate<string | null>(focusedKey)).toBe(fourth);
    await waitFor(`${currentKey} === ${JSON.stringify(fourth)}`);

    // A character that is not one of the list's keys goes into the composer, and lands there.
    await waitFor(composerShown);
    await browser("press", "h");
    await waitFor(typing);
    expect(await evaluate<string>(`document.activeElement.value`)).toEndWith("h");
  } finally {
    await browser("close").catch(() => undefined);
    await db.$disconnect();
  }
}, 180_000);

test("Unread keeps the row the pane shows until the selection moves on", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate, waitFor } = browserSession(
    browserPath,
    `activity-flow-unread-${process.pid}`,
  );
  const rows = `[...document.querySelectorAll(${rowItems})]`;
  const seeded = `${rows}.filter((row) => row.textContent.includes("e2e-keys"))`;
  const keyOf = (row: string) => `${row}?.getAttribute("data-activity-row") ?? null`;
  const focusedKey = keyOf(`${rows}.find((row) => row.contains(document.activeElement))`);
  const listed = (key: string) =>
    `${rows}.some((row) => row.getAttribute("data-activity-row") === ${JSON.stringify(key)})`;
  try {
    const { workspace, workspaceId } = await devBrowserWorkspace(db);
    await seedActivityKeys(db, workspaceId);
    await browser("set", "viewport", "1440", "900");
    await browser("open", `${origin}/en/w/${workspace.slug}/activity?filter=unread`);
    // The unread channel and its thread; the read channel is not in this view.
    await waitFor(`${seeded}.length === 2 && ${pageHydrated}`, 40_000);
    await Bun.sleep(2_000);

    // Opening the first reads it; it stays, with the caret, while the pane shows it.
    const first = await evaluate<string>(keyOf(`${seeded}[0]`));
    await evaluate(`(${seeded}[0].querySelector("a").focus(), true)`);
    await browser("press", "Enter");
    await waitFor(`${openParam} !== null`);
    await Bun.sleep(3_000);
    expect(await evaluate<boolean>(listed(first))).toBe(true);
    expect(await evaluate<string | null>(focusedKey)).toBe(first);

    // Moving on opens the row below it (the workspace's other unread rows may sit between the
    // seeded two), and the read row leaves the view.
    const firstOpen = await evaluate<string>(openParam);
    const next = await evaluate<string>(
      keyOf(`${rows}[${rows}.findIndex((row) => row.contains(document.activeElement)) + 1]`),
    );
    await browser("press", "j");
    await waitFor(`${openParam} !== ${JSON.stringify(firstOpen)}`);
    await waitFor(`!${listed(first)}`);
    expect(await evaluate<string | null>(focusedKey)).toBe(next);
  } finally {
    await browser("close").catch(() => undefined);
    await db.$disconnect();
  }
}, 180_000);
