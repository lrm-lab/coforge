import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { WHATS_NEW_ENTRIES, pendingWhatsNew } from "#src/features/whats-new/whats-new-entries";
import { animationsSettled, browserSession, localBrowserE2e } from "./helpers/browser-e2e";

const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.artifacts/e2e/whats-new");
const pinned = process.env.COFORGE_E2E_WHATS_NEW_NOW;
const now = pinned ? new Date(pinned) : new Date();

test("What's new keeps a row in the sidebar with a dot while entries wait, on every device", async () => {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl }),
  });
  const first = browserSession(browserPath, `whats-new-a-${process.pid}`);
  const second = browserSession(browserPath, `whats-new-b-${process.pid}`);
  const { workspace } = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id },
    orderBy: { createdAt: "asc" },
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
  const pending = pendingWhatsNew(WHATS_NEW_ENTRIES, {
    now,
    joinedAt: joined,
    dismissed: [],
    experimentOn: () => true,
  });
  const titles: Record<string, string> = {
    "task-labels": "Labels for tasks",
    artifacts: "Meet Artifacts",
    "agent-usage": "Agent token usage in Profiles",
    feedback: "Send feedback right in CoForge",
  };

  const entry = `[...document.querySelectorAll('button')].find((el) => (el.textContent === "What's new" || el.getAttribute("aria-label") === "What's new") && el.getBoundingClientRect().width > 0 && el.checkVisibility({ visibilityProperty: true, opacityProperty: true }))`;
  const dot = `(${entry})?.querySelector("span.size-2.rounded-full") != null`;
  const dialog = `([...document.querySelectorAll('[role="dialog"]')].find((el) => el.getAttribute("aria-label") === "What's new") ?? null)`;
  const feedbackDialog = `([...document.querySelectorAll('[role="dialog"]')].find((el) => el.querySelector("h2")?.textContent?.trim() === "Send feedback") ?? null)`;
  const heading = `(${dialog}?.querySelector("h2")?.textContent ?? null)`;
  const settled = (b: typeof first) => b.browser("wait", "--fn", animationsSettled());
  const shoot = async (b: typeof first, shot: string) => {
    await settled(b);
    await b.browser("screenshot", join(artifacts, `${shot}.png`));
    await b.evaluate(`document.documentElement.classList.add("dark-mode") ?? true`);
    await b.browser("wait", "400");
    await b.browser("screenshot", join(artifacts, `${shot}-dark.png`));
    await b.evaluate(`document.documentElement.classList.remove("dark-mode") ?? true`);
  };
  const page = `${origin}/en/w/${workspace.slug}/tasks`;
  const open = async (
    b: typeof first,
    ready = `document.querySelector('[data-sidebar]') !== null`,
  ) => {
    await b.browser("open", page);
    await b.browser("wait", "--fn", ready);
    await b.browser("wait", "1500");
  };
  const press = async (b: typeof first, target: string) => {
    await b.evaluate(`((${target}).setAttribute("data-e2e-press", ""), true)`);
    await b.browser("click", "[data-e2e-press]");
    await b.evaluate(
      `(document.querySelector("[data-e2e-press]")?.removeAttribute("data-e2e-press"), true)`,
    );
  };
  const pressText = (b: typeof first, text: string) =>
    press(
      b,
      `[...${dialog}.querySelectorAll("button")].find((el) => el.textContent === "${text}")`,
    );

  await mkdir(artifacts, { recursive: true });
  try {
    await db.user.update({ where: { id: DEV_BROWSER_USER.id }, data: { createdAt: joined } });
    await setDismissed([]);
    await first.browser("set", "viewport", "1280", "860");
    await second.browser("set", "viewport", "1280", "860");

    await open(first);
    expect(await first.evaluate(`(${entry}) != null`)).toBe(pending.length > 0);
    if (pending.length === 0) return;
    expect(await first.evaluate(dot)).toBe(true);
    await shoot(first, "desktop-1-row");

    await press(first, entry);
    await first.browser("wait", "--fn", `${dialog} !== null`);
    expect(await first.evaluate(heading)).toBe(titles[pending[0]!]!);
    await shoot(first, "desktop-2-dialog");
    for (const id of pending.slice(1)) {
      await pressText(first, "Next");
      expect(await first.evaluate(heading)).toBe(titles[id]!);
    }
    await pressText(first, "Got it");
    await first.browser("wait", "--fn", `${dialog} === null`);
    expect(await first.evaluate(`(${entry}) == null`)).toBe(true);
    await shoot(first, "desktop-4-seen");

    await open(second);
    expect(await second.evaluate(`(${entry}) == null`)).toBe(true);

    await setDismissed([]);
    await open(second);
    await press(second, entry);
    await second.browser("wait", "--fn", `${dialog} !== null`);
    await second.browser("press", "Escape");
    await second.browser("wait", "--fn", `${dialog} === null`);
    await second.browser("wait", "500");
    expect(
      (await db.userPreference.findUniqueOrThrow({ where: { userId: DEV_BROWSER_USER.id } }))
        .whatsNewDismissed,
    ).toEqual([pending[0]!]);

    if (pending.at(-1) === "feedback") {
      await setDismissed(pending.slice(0, -1));
      await open(first);
      await press(first, entry);
      await first.browser("wait", "--fn", `${dialog} !== null`);
      expect(await first.evaluate(heading)).toBe(titles.feedback!);
      await pressText(first, "Send feedback");
      await first.browser("wait", "--fn", `${dialog} === null`);
      await first.browser("wait", "--fn", `${feedbackDialog} !== null`);
      await first.browser("press", "Escape");
      await first.browser("wait", "--fn", `${feedbackDialog} === null`);
    }

    await setDismissed([]);
    await open(first);
    const visible = (label: string) =>
      `[...document.querySelectorAll('[aria-label="${label}"]')].find((el) => el.getBoundingClientRect().width > 0 && el.checkVisibility({ visibilityProperty: true, opacityProperty: true }))`;
    await press(first, visible("Collapse sidebar"));
    await first.browser(
      "wait",
      "--fn",
      `document.documentElement.classList.contains("sidebar-collapsed")`,
    );
    await first.browser("wait", "--fn", `(${entry})?.getAttribute("aria-label") === "What's new"`);
    expect(await first.evaluate(dot)).toBe(true);
    await shoot(first, "desktop-3-rail");
    await press(first, visible("Expand sidebar"));

    await first.browser("set", "viewport", "390", "844");
    await open(
      first,
      `document.querySelector("main") !== null && document.querySelector('[data-sidebar]') === null`,
    );
    expect(await first.evaluate(`(${entry}) == null`)).toBe(true);
    await first.browser("open", `${origin}/en/w/${workspace.slug}/me`);
    await first.browser("wait", "--fn", `(${entry}) != null`);
    await shoot(first, "phone-1-menu");
    await press(first, entry);
    await first.browser("wait", "--fn", `${dialog} !== null`);
    await shoot(first, "phone-2-dialog");
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
