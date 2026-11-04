import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { WHATS_NEW_ENTRIES, pendingWhatsNew } from "#src/features/whats-new/whats-new-entries";
import { browserSession, localBrowserE2e } from "./helpers/browser-e2e";

/**
 * The "What's new" card (task #493) in a real browser: a person who joined after the releases sees
 * none; "Got it" brings the next; a second browser (another device) keeps what was dismissed.
 * Desktop and phone. Entries that wait on an experiment are covered by `whats-new.integration.ts`.
 *
 * Opt-in like the other browser E2Es: real local Web and `agent-browser`. Entries show only from
 * their release time, so to run before it start the Web with `COFORGE_E2E_WHATS_NEW_NOW` (honoured
 * only with the dev sign-in bypass) and pass the same value here. Without it the test checks only
 * what the real time allows. The dev user's dismissals and join time are restored after the
 * run. Screenshots go under `.amp/e2e/whats-new/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/whats-new");
const pinned = process.env.COFORGE_E2E_WHATS_NEW_NOW;
const now = pinned ? new Date(pinned) : new Date();

test("the What's new card shows what is new to this person, one at a time, on every device", async () => {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl }),
  });
  const first = browserSession(browserPath, `whats-new-a-${process.pid}`);
  const second = browserSession(browserPath, `whats-new-b-${process.pid}`);
  const { workspace } = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id },
    include: { workspace: { select: { slug: true } } },
  });
  const user = await db.user.findUniqueOrThrow({
    where: { id: DEV_BROWSER_USER.id },
    select: {
      createdAt: true,
      preferences: { select: { whatsNewDismissed: true } },
    },
  });
  const restore = {
    createdAt: user.createdAt,
    dismissed: user.preferences?.whatsNewDismissed ?? [],
  };
  const setDismissed = (whatsNewDismissed: string[]) =>
    db.userPreference.upsert({
      where: { userId: DEV_BROWSER_USER.id },
      create: { userId: DEV_BROWSER_USER.id, whatsNewDismissed },
      update: { whatsNewDismissed },
    });
  const joined = new Date("2026-01-01T00:00:00Z");
  const expected = (dismissed: string[]) =>
    pendingWhatsNew(WHATS_NEW_ENTRIES, {
      now,
      joinedAt: joined,
      dismissed,
      experimentOn: () => true,
    });

  // The desktop sidebar keeps its markup on a phone, hidden: the card meant is the one on screen.
  const card = `[...document.querySelectorAll('section[aria-label="New"]')].find((el) => el.getBoundingClientRect().width > 0)`;
  const title = `(${card}?.querySelector("h2")?.textContent ?? null)`;
  const settled = (b: typeof first) =>
    b.browser("wait", "--fn", `document.getAnimations().every((a) => a.playState !== "running")`);
  const shoot = async (b: typeof first, shot: string) => {
    await settled(b);
    await b.browser("screenshot", join(artifacts, `${shot}.png`));
    await b.evaluate(`document.documentElement.classList.add("dark-mode") ?? true`);
    // Colors ease between themes; let them land.
    await b.browser("wait", "400");
    await b.browser("screenshot", join(artifacts, `${shot}-dark.png`));
    await b.evaluate(`document.documentElement.classList.remove("dark-mode") ?? true`);
  };
  const page = `${origin}/en/w/${workspace.slug}/tasks`;
  const open = async (b: typeof first) => {
    await b.browser("open", page);
    await b.browser("wait", "--fn", `document.querySelector('[data-sidebar]') !== null`);
    // The card comes after the sidebar, once its read returns.
    await b.browser("wait", "1500");
  };
  const titles: Record<string, string> = {
    "task-labels": "Labels for Tasks",
  };
  const shown = async (b: typeof first) => (await b.evaluate(title)) as string | null;

  await mkdir(artifacts, { recursive: true });
  try {
    await db.user.update({
      where: { id: DEV_BROWSER_USER.id },
      data: { createdAt: joined },
    });
    await setDismissed([]);
    await first.browser("set", "viewport", "1280", "860");
    await second.browser("set", "viewport", "1280", "860");

    // Every released entry is new to someone who joined before them, oldest first.
    const queue = expected([]);
    await open(first);
    expect(await shown(first)).toBe(queue[0] ? titles[queue[0]]! : null);
    if (queue.length === 0) return;
    await shoot(first, "desktop-1-first");

    // "Got it" brings the next at once, and the choice is kept for another device.
    await first.evaluate(
      `([...${card}.querySelectorAll("button")].find((b) => b.textContent === "Got it").click(), true)`,
    );
    await first.browser("wait", "500");
    const rest = expected([queue[0]!]);
    expect(await shown(first)).toBe(rest[0] ? titles[rest[0]]! : null);
    if (rest[0]) await shoot(first, "desktop-2-next");
    await open(second);
    expect(await shown(second)).toBe(rest[0] ? titles[rest[0]]! : null);

    // Someone who joined after every release sees no card.
    await db.user.update({
      where: { id: DEV_BROWSER_USER.id },
      data: { createdAt: new Date(now.getTime() - 1000) },
    });
    await open(second);
    expect(await shown(second)).toBe(null);

    // On a phone the card sits at the foot of the menu, never over the page.
    await setDismissed([]);
    await db.user.update({
      where: { id: DEV_BROWSER_USER.id },
      data: { createdAt: joined },
    });
    await first.browser("set", "viewport", "390", "844");
    await open(first);
    expect(await first.evaluate(`(${card}) === undefined`)).toBe(true);
    await first.evaluate(
      `([...document.querySelectorAll('[aria-label="Open menu"]')].find((el) => el.getBoundingClientRect().width > 0).click(), true)`,
    );
    await first.browser("wait", "--fn", `(${card}) !== undefined`);
    await shoot(first, "phone-1-menu");
  } finally {
    await db.user.update({
      where: { id: DEV_BROWSER_USER.id },
      data: { createdAt: restore.createdAt },
    });
    await setDismissed(restore.dismissed);
    await first.browser("close").catch(() => {});
    await second.browser("close").catch(() => {});
    await db.$disconnect();
  }
}, 240_000);
