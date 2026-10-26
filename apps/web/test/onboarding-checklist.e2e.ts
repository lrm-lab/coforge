import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { hydrated, openBrowser } from "./e2e-sign-in-harness";

/**
 * The "Finish setting up" card in the Workspace sidebar, in a real browser: it lists the steps the
 * viewer has not done, a step done elsewhere ticks off after a reload and moves the progress, a
 * step's row runs its action (the Agent row opens the new-Agent dialog on the Members page), and
 * closing the card keeps it gone after a reload.
 *
 * Opt-in like the other browser E2Es: real local Web (`COFORGE_DEV_SKIP_AUTH`) + `agent-browser`.
 * It creates and removes its own Workspace (the dev user its owner). GitHub and Computer
 * steps depend on the deployment and the dev user, so the test reads the total from the page.
 * Screenshots go to `.amp/e2e/onboarding-checklist/`: `card.png`, `ticked.png`, `agent-dialog.png`.
 */
const origin = Bun.env.COFORGE_E2E_WEB_URL;
if (!origin || !["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  throw new Error("COFORGE_E2E_WEB_URL must target the local Web service");
const databaseUrl = Bun.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1")
  throw new Error("DATABASE_URL must target local PostgreSQL");
const artifacts = join(import.meta.dir, "../../../.amp/e2e/onboarding-checklist");
const slug = `e2e-onboarding-${process.pid}`;
/** The page has hydrated: a click on its sidebar will do something. */
const pageReady = hydrated('document.querySelector("aside[data-sidebar]")');
/** The visible card: its progressbar's value and maximum, and each step row's name and state. */
const card = `(() => {
  const section = document.querySelector('[data-setup-checklist="open"]');
  if (!section) return null;
  const bar = section.querySelector('[role="progressbar"]');
  return {
    now: Number(bar.getAttribute("aria-valuenow")),
    max: Number(bar.getAttribute("aria-valuemax")),
    rows: [...section.querySelectorAll("li button")].map((row) => row.textContent),
  };
})()`;

test("the setup checklist ticks a step, runs a step's action and stays closed once closed", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate, waitFor } = openBrowser(`onboarding-checklist-${process.pid}`);
  let workspaceId: string | undefined;
  try {
    const workspace = await db.workspace.create({
      data: {
        name: "E2E onboarding",
        slug,
        members: { create: { userId: DEV_BROWSER_USER.id, role: "owner" } },
      },
    });
    workspaceId = workspace.id;
    await mkdir(artifacts, { recursive: true });
    const path = `${origin}/en/w/${slug}`;

    await browser("set", "viewport", "1440", "900");
    await browser("open", path);
    await waitFor(pageReady);
    // Workspace-open provisions a weekly-report Agent with systemKind=null. Keep it inactive in
    // this fixture so only the ordinary Agent created below completes the first-Agent step.
    await db.agent.updateMany({
      where: { workspaceId: workspace.id, weeklyReportAssistant: { isNot: null } },
      data: { deletedAt: new Date() },
    });
    // The dismissal is stored with the member: forget one a previous run left.
    await db.workspaceMemberPreference.updateMany({
      where: { workspaceId: workspace.id, userId: DEV_BROWSER_USER.id },
      data: { setupChecklistDismissedAt: null },
    });
    await browser("open", path);
    await waitFor(`${pageReady} && ${card} !== null`);
    const first = (await evaluate<{ now: number; max: number; rows: string[] }>(card))!;
    expect(first.rows.map((row) => row.replace(/(?:To do|Done)$/, ""))).toEqual(
      first.max === 3
        ? ["Connect GitHub", "Create your first Agent", "Connect your own computer"]
        : ["Create your first Agent", "Connect your own computer"],
    );
    expect(first.max).toBe(first.rows.length);
    expect(first.rows.find((row) => row.includes("Create your first Agent"))).toContain("To do");
    expect(first.now).toBeLessThan(first.max);
    await browser("screenshot", join(artifacts, "card.png"));

    // Creating an ordinary Agent elsewhere ticks the remaining Agent step.
    await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: DEV_BROWSER_USER.id,
        name: "checklist-agent",
        displayName: "Checklist Agent",
        runtimeConfig: {
          runtime: "pi",
          provider: { kind: "default" },
          model: "",
          modelProvider: "",
          reasoning: "",
        },
      },
    });
    await browser("open", path);
    await waitFor(`${pageReady} && ${card} !== null`);
    const ticked = (await evaluate<{ now: number; max: number; rows: string[] }>(card))!;
    expect(ticked.rows.find((row) => row.includes("Create your first Agent"))).toContain("Done");
    expect(ticked.now).toBe(first.now + 1);
    expect(ticked.max).toBe(first.max);
    await browser("screenshot", join(artifacts, "ticked.png"));

    // A row runs its own action: the Agent row opens the new-Agent dialog on the Members page.
    await browser("find", "role", "button", "click", "--name", "Create your first Agent");
    await waitFor(`location.pathname.endsWith("/w/${slug}/members") && ${pageReady}`);
    await waitFor(`document.querySelector('[role="dialog"]') !== null`);
    // The dialog is addressed by the URL, and closing it clears that.
    expect(await evaluate<string>("location.search")).toContain("setup=create-agent");
    await browser("screenshot", join(artifacts, "agent-dialog.png"));
    await browser("press", "Escape");
    await waitFor(`!location.search.includes("setup=")`);

    // Closing the card is stored with the member, so it stays gone after a reload.
    await browser("find", "role", "button", "click", "--name", "Dismiss the setup checklist");
    expect(await evaluate<null>(card)).toBeNull();
    await browser("open", path);
    await waitFor(pageReady);
    await Bun.sleep(1500);
    expect(await evaluate<null>(card)).toBeNull();
    expect(
      (
        await db.workspaceMemberPreference.findUniqueOrThrow({
          where: { workspaceId_userId: { workspaceId: workspace.id, userId: DEV_BROWSER_USER.id } },
        })
      ).setupChecklistDismissedAt,
    ).not.toBeNull();
  } finally {
    if (workspaceId) await db.workspace.delete({ where: { id: workspaceId } });
    await db.$disconnect();
  }
});
