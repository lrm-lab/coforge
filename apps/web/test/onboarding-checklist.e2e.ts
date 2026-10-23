import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { agentDirectKey } from "#src/features/conversations/direct-key";
import { WorkspaceAssistants } from "#src/server/agents/workspace-assistants.server";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { hydrated, openBrowser, seededUuid } from "./e2e-sign-in-harness";

/**
 * The "Finish setting up" card in the Workspace sidebar, in a real browser: it lists the steps the
 * viewer has not done, a step done elsewhere ticks off after a reload and moves the progress, a
 * step's row runs its action (the Agent row opens the new-Agent dialog on the Members page), and
 * closing the card keeps it gone after a reload.
 *
 * Opt-in like the other browser E2Es: real local Web (`COFORGE_DEV_SKIP_AUTH`) + `agent-browser`.
 * It seeds its own Workspace (`e2e-onboarding`, the dev user its owner) and removes the dev user's
 * messages to their assistant there, so a rerun starts from the same card. GitHub and Computer
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
const slug = "e2e-onboarding";
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
  try {
    const workspace = await db.workspace.upsert({
      where: { id: seededUuid("e2e-onboarding:workspace") },
      update: { slug },
      create: { id: seededUuid("e2e-onboarding:workspace"), name: "E2E onboarding", slug },
    });
    await db.workspaceMembership.upsert({
      where: { workspaceId_userId: { workspaceId: workspace.id, userId: DEV_BROWSER_USER.id } },
      update: { role: "owner" },
      create: { workspaceId: workspace.id, userId: DEV_BROWSER_USER.id, role: "owner" },
    });
    // Whatever the viewer said to their assistant last run is forgotten.
    await db.message.deleteMany({
      where: { workspaceId: workspace.id, sender: { userId: DEV_BROWSER_USER.id } },
    });
    await mkdir(artifacts, { recursive: true });
    const path = `${origin}/en/w/${slug}`;

    await browser("set", "viewport", "1440", "900");
    await browser("open", path);
    await waitFor(pageReady);
    // The dismissal is stored with the member: forget one a previous run left.
    await db.workspaceMemberPreference.updateMany({
      where: { workspaceId: workspace.id, userId: DEV_BROWSER_USER.id },
      data: { setupChecklistDismissedAt: null },
    });
    await browser("open", path);
    await waitFor(`${pageReady} && ${card} !== null`);
    const first = (await evaluate<{ now: number; max: number; rows: string[] }>(card))!;
    expect(first.rows[0]).toContain("Say hi to your assistant");
    expect(first.rows[0]).toContain("To do");
    expect(first.now).toBeLessThan(first.max);
    await browser("screenshot", join(artifacts, "card.png"));

    // Saying hi elsewhere (here: a row, as a sent message would leave it) ticks the step.
    const { agentId, conversationId } = await new WorkspaceAssistants(db).ensure(
      workspace.id,
      DEV_BROWSER_USER.id,
    );
    const viewer = await db.conversationMember.findFirstOrThrow({
      where: { conversationId, userId: DEV_BROWSER_USER.id },
    });
    expect(
      (await db.conversation.findUniqueOrThrow({ where: { id: conversationId } })).directKey,
    ).toBe(agentDirectKey(DEV_BROWSER_USER.id, agentId));
    const last = await db.message.aggregate({
      where: { conversationId },
      _max: { sequence: true },
    });
    await db.message.create({
      data: {
        conversationId,
        workspaceId: workspace.id,
        senderMemberId: viewer.id,
        body: "hi",
        sequence: (last._max.sequence ?? 0) + 1,
      },
    });
    await browser("open", path);
    await waitFor(`${pageReady} && ${card} !== null`);
    const ticked = (await evaluate<{ now: number; max: number; rows: string[] }>(card))!;
    expect(ticked.rows[0]).toContain("Done");
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
    await db.$disconnect();
  }
});
