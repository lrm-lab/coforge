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

const { origin, browserPath, databaseUrl } = localBrowserE2e();

test("the Activity list moves, reads, marks Done and opens from the keyboard", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate, waitFor } = browserSession(
    browserPath,
    `activity-keys-${process.pid}`,
  );
  const rows = `[...document.querySelectorAll(${rowItems})]`;
  const seeded = `${rows}.filter((row) => row.textContent.includes("e2e-keys"))`;
  const focused = `${rows}.findIndex((row) => row.contains(document.activeElement))`;
  const focusSeeded = (index: number) =>
    evaluate(`(${seeded}[${index}].querySelector("a").focus(), true)`);
  const unreadExpression = (index: number) =>
    `[...${seeded}[${index}].querySelectorAll("[aria-label]")].some((el) => /\\d+ new/.test(el.getAttribute("aria-label")))`;
  const isUnread = (index: number) => evaluate<boolean>(unreadExpression(index));
  try {
    const { workspaceId, workspace } = await devBrowserWorkspace(db);
    const { unread, read } = await seedActivityKeys(db, workspaceId);
    await browser("set", "viewport", "1440", "900");
    await browser("open", `${origin}/en/w/${workspace.slug}/activity`);
    await waitFor(`${seeded}.length === 4 && ${pageHydrated}`, 40_000);
    expect(
      await evaluate<number>(
        `${rows}.filter((row) => row.hasAttribute("data-activity-row") && row.querySelector("a").tabIndex === 0).length`,
      ),
    ).toBe(1);

    await Bun.sleep(2_000);
    await focusSeeded(0);
    const start = await evaluate<number>(focused);
    expect(start).toBeGreaterThanOrEqual(0);
    await browser("press", "ArrowDown");
    expect(await evaluate<number>(focused)).toBe(start + 1);
    await browser("press", "j");
    expect(await evaluate<number>(focused)).toBe(start + 2);
    await browser("press", "ArrowUp");
    expect(await evaluate<number>(focused)).toBe(start + 1);
    await browser("press", "k");
    expect(await evaluate<number>(focused)).toBe(start);
    expect(
      await evaluate<number>(
        `${rows}.filter((row) => row.hasAttribute("data-activity-row") && row.querySelector("a").tabIndex === 0).length`,
      ),
    ).toBe(1);

    const unreadAt = await evaluate<number>(
      `${seeded}.findIndex((row) => row.textContent.includes("e2e-keys-design") && !row.textContent.includes("launch"))`,
    );
    expect(unreadAt).toBeGreaterThanOrEqual(0);
    await focusSeeded(unreadAt);
    expect(await isUnread(unreadAt)).toBe(true);
    await browser("press", "r");
    await waitFor(`!${unreadExpression(unreadAt)}`);
    expect(
      (await db.conversationMember.findUniqueOrThrow({ where: { id: unread.viewer.id } }))
        .readThroughSequence,
    ).toBeGreaterThanOrEqual(5);
    await browser("press", "r");
    await waitFor(unreadExpression(unreadAt));
    expect(await evaluate<boolean>(`${seeded}[${unreadAt}].contains(document.activeElement)`)).toBe(
      true,
    );

    const before = await evaluate<string[]>(`${seeded}.map((row) => row.textContent)`);
    await evaluate(`(() => {
      const input = document.createElement("input");
      input.id = "keys-probe";
      ${seeded}[${unreadAt}].append(input);
      input.focus();
      return true;
    })()`);
    for (const key of ["e", "r", "j", "k", "ArrowDown"]) await browser("press", key);
    await Bun.sleep(1_000);
    expect(await evaluate<string>(`document.activeElement?.id ?? ""`)).toBe("keys-probe");
    expect(await evaluate<string[]>(`${seeded}.map((row) => row.textContent)`)).toEqual(before);
    await evaluate(`(document.getElementById("keys-probe")?.remove(), true)`);

    await focusSeeded(0);
    const doneText = await evaluate<string>(`${seeded}[0].textContent`);
    const nextText = await evaluate<string>(
      `${rows}[${await evaluate<number>(focused)} + 1].textContent`,
    );
    await browser("press", "e");
    await waitFor(`!${rows}.some((row) => row.textContent === ${JSON.stringify(doneText)})`);
    expect(await evaluate<string>(`${rows}[${focused}]?.textContent ?? ""`)).toBe(nextText);
    expect(
      await evaluate<number>(
        `${rows}.filter((row) => row.hasAttribute("data-activity-row") && row.querySelector("a").tabIndex === 0).length`,
      ),
    ).toBe(1);
    const done = await db.conversationMember.findMany({
      where: { id: { in: [unread.viewer.id, read.viewer.id] } },
      select: { doneThroughSequence: true },
    });
    expect(done.some((member) => member.doneThroughSequence !== null)).toBe(true);

    expect(await evaluate<string | null>(openParam)).toBeNull();
    await browser("press", "Enter");
    await waitFor(`${openParam} !== null`);
  } finally {
    await browser("close").catch(() => undefined);
    await db.$disconnect();
  }
}, 180_000);
