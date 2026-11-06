import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { sidePanelPinStorageKey } from "#src/features/records/record-side-panel-pin";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";

/**
 * The Record side panel fills the page where the document is hidden behind it, and stays a side
 * column beside the document on a wide screen. Seeds a draft report and removes it after the run.
 * Screenshots, light and dark, are written under `.amp/e2e/record-side-panel-phone/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/record-side-panel-phone");

test("the Record side panel fills the page below the width it can sit beside the document", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `record-panel-${process.pid}`);
  const { workspaceId, workspace } = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id, role: "owner" },
    include: { workspace: { select: { slug: true } } },
  });
  // A year no real cycle uses, so the unique (workspace, year, week) never collides.
  const year = 2900 + (process.pid % 90);
  const cycle = await db.weeklyReportCycle.create({
    data: { workspaceId, year, week: 1, title: "E2E week", createdById: DEV_BROWSER_USER.id },
  });
  const report = await db.weeklyReport.create({
    data: {
      workspaceId,
      cycleId: cycle.id,
      authorId: DEV_BROWSER_USER.id,
      kind: "member",
      title: "Side panel report",
      content: { body: "What shipped this week." },
    },
  });
  const page = `${origin}/en/w/${workspace.slug}/records/${report.id}`;
  const panel = `[...document.querySelectorAll("aside")].find((aside) => aside.querySelector('[role="separator"]'))`;
  const settled = `${pageHydrated} && ${panel} !== undefined && ${panel}.getAttribute("aria-hidden") === "false" && ${panel}.getAnimations().length === 0`;
  const widths = `(() => ({ panel: Math.round(${panel}.getBoundingClientRect().width), page: document.documentElement.clientWidth }))()`;
  const shots = async (name: string) => {
    await browser("screenshot", join(artifacts, `${name}.png`));
    await evaluate(`document.documentElement.classList.add("dark-mode") ?? true`);
    await browser("screenshot", join(artifacts, `${name}-dark.png`));
    await evaluate(`document.documentElement.classList.remove("dark-mode") ?? true`);
  };
  try {
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "390", "844");
    await browser("open", page);
    await evaluate(
      `localStorage.setItem(${JSON.stringify(sidePanelPinStorageKey("report", report.id))}, "1") ?? true`,
    );
    await browser("open", page);
    await browser("wait", "--fn", settled);
    const phone = await evaluate<{ panel: number; page: number }>(widths);
    await shots("phone");
    expect(phone.panel).toBe(phone.page);

    await browser("set", "viewport", "820", "1100");
    await browser("open", page);
    await browser("wait", "--fn", settled);
    await browser("wait", "400");
    const tablet = await evaluate<{ panel: number; page: number }>(widths);
    expect(tablet.panel).toBe(
      await evaluate<number>(`Math.round(${panel}.parentElement.clientWidth)`),
    );

    await browser("set", "viewport", "1440", "900");
    await browser("open", page);
    await browser("wait", "--fn", settled);
    await browser("wait", "400");
    const wide = await evaluate<{ panel: number; page: number }>(widths);
    await shots("desktop");
    expect(wide.panel).toBeLessThanOrEqual(wide.page / 2);
  } finally {
    await browser("close").catch(() => undefined);
    await db.weeklyReport.deleteMany({ where: { id: report.id } }).catch(() => undefined);
    await db.weeklyReportCycle.deleteMany({ where: { id: cycle.id } }).catch(() => undefined);
    await db.$disconnect();
  }
}, 120_000);
