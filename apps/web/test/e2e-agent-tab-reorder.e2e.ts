import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";

/**
 * Task #233: the Agent panel's tabs are reordered with the mouse and with the keyboard (Space picks
 * the focused tab up, the arrow keys move it, Space drops it, Escape puts it back), each step is
 * announced, and the order is saved for the member: after a reload the panel shows it and opens on
 * its first tab.
 *
 * Opt-in like the other browser E2Es: real local Web (`COFORGE_DEV_SKIP_AUTH=1`) + `agent-browser`
 * against the dev database, with an Agent in the dev user's Workspace. It puts back the member's
 * saved order. Screenshots are written under `.amp/e2e/agent-tab-reorder/`.
 */
const origin = Bun.env.COFORGE_E2E_WEB_URL;
if (!origin || !["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  throw new Error("COFORGE_E2E_WEB_URL must target the local Web service");
const browserPath = Bun.which("agent-browser");
if (!browserPath) throw new Error("agent-browser is required");
const databaseUrl = Bun.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1")
  throw new Error("DATABASE_URL must target local PostgreSQL");
const artifacts = join(import.meta.dir, "../../../.amp/e2e/agent-tab-reorder");

test("the Agent panel's tabs reorder by mouse and keyboard, and the order is kept", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const session = `agent-tab-reorder-${process.pid}`;
  async function browser(...args: string[]) {
    const child = Bun.spawn([browserPath!, "--session", session, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(`Browser ${args[0]} failed: ${stderr}`);
    return stdout;
  }
  async function evaluate<T>(expression: string): Promise<T> {
    return JSON.parse(JSON.parse(await browser("eval", `JSON.stringify(${expression})`))) as T;
  }
  const TAB = `[role="tablist"][aria-label="Agent"] [role="tab"]`;
  const tabs = () =>
    evaluate<string[]>(
      `[...document.querySelectorAll('${TAB}')].map((tab) => tab.textContent.trim())`,
    );
  const waitForTabs = (order: string[]) =>
    browser(
      "wait",
      "--fn",
      `JSON.stringify([...document.querySelectorAll('${TAB}')].map((tab) => tab.textContent.trim())) === ${JSON.stringify(JSON.stringify(order))}`,
    );
  /** Waits for the strip's live region to say `text`. */
  const announced = (text: string) =>
    browser(
      "wait",
      "--fn",
      `[...document.querySelectorAll('[aria-live="assertive"]')].some((region) => region.textContent === ${JSON.stringify(text)})`,
    );
  const centre = (index: number) =>
    evaluate<[number, number]>(
      `(() => { const box = document.querySelectorAll('${TAB}')[${index}].getBoundingClientRect(); return [Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2)]; })()`,
    );
  const membership = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id },
    include: { workspace: { select: { id: true, slug: true } } },
  });
  const workspaceId = membership.workspace.id;
  const where = { workspaceId_userId: { workspaceId, userId: DEV_BROWSER_USER.id } };
  const saved = await db.workspaceMemberPreference.findUnique({ where });
  const savedOrder = async () =>
    (await db.workspaceMemberPreference.findUnique({ where }))?.agentProfileTabOrder ?? [];
  const waitForSaved = async (order: string[]) => {
    const ids = order.map((label) => label.toLowerCase());
    for (let tries = 0; tries < 50; tries += 1) {
      if (JSON.stringify(await savedOrder()) === JSON.stringify(ids)) return;
      await Bun.sleep(100);
    }
    expect(await savedOrder()).toEqual(ids);
  };

  try {
    const agent = await db.agent.findFirstOrThrow({
      where: { workspaceId, deletedAt: null, systemKind: null, ownerId: DEV_BROWSER_USER.id },
      select: { id: true },
    });
    if (saved)
      await db.workspaceMemberPreference.update({ where, data: { agentProfileTabOrder: [] } });
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1440", "900");
    await browser(
      "open",
      `${origin}/en/w/${membership.workspace.slug}/members?profile=agent:${agent.id}`,
    );
    await browser("wait", "--fn", `document.querySelectorAll('${TAB}').length > 2`);
    const start = await tabs();

    // The mouse: the first tab dragged onto the third.
    const [fromX, y] = await centre(0);
    const [toX] = await centre(2);
    await browser("mouse", "move", String(fromX), String(y));
    await browser("mouse", "down");
    for (let step = 1; step <= 6; step += 1)
      await browser(
        "mouse",
        "move",
        String(Math.round(fromX + ((toX - fromX) * step) / 6)),
        String(y),
      );
    await browser("mouse", "up");
    const dragged = [start[1], start[2], start[0], ...start.slice(3)];
    await waitForTabs(dragged);
    await waitForSaved(dragged);

    // The keyboard: Space picks the focused tab up, an arrow moves it, Escape puts it back.
    await browser("focus", `${TAB}:nth-child(1)`);
    await browser("press", "Space");
    await announced(`Picked up ${dragged[0]}, position 1 of ${dragged.length}.`);
    await browser("press", "ArrowRight");
    await waitForTabs([dragged[1], dragged[0], ...dragged.slice(2)]);
    await browser("screenshot", join(artifacts, "keyboard-moving.png"));
    await browser("press", "Escape");
    await waitForTabs(dragged);
    await announced(`Cancelled. ${dragged[0]} is back at position 1 of ${dragged.length}.`);

    // Space, End and Space move it to the end and keep it there; focus stays on it.
    await browser("press", "Space");
    await browser("press", "End");
    await browser("press", "Space");
    const keyed = [...dragged.slice(1), dragged[0]];
    await waitForTabs(keyed);
    await announced(`Dropped ${dragged[0]} at position ${keyed.length} of ${keyed.length}.`);
    expect(await evaluate<string>(`document.activeElement.textContent.trim()`)).toBe(dragged[0]);
    await waitForSaved(keyed);

    // A reload shows the order, open on its first tab.
    await browser(
      "open",
      `${origin}/en/w/${membership.workspace.slug}/members?profile=agent:${agent.id}`,
    );
    await browser("wait", "--fn", `document.querySelectorAll('${TAB}').length > 2`);
    await waitForTabs(keyed);
    await browser(
      "wait",
      "--fn",
      `document.querySelector('${TAB}[aria-selected="true"]')?.textContent.trim() === ${JSON.stringify(keyed[0])}`,
    );
    await browser("screenshot", join(artifacts, "reloaded.png"));
  } finally {
    // The member's preferences as they were: their row back, or none if they had none.
    await (
      saved
        ? db.workspaceMemberPreference.update({
            where,
            data: { agentProfileTabOrder: saved.agentProfileTabOrder },
          })
        : db.workspaceMemberPreference.deleteMany({
            where: { workspaceId, userId: DEV_BROWSER_USER.id },
          })
    ).catch(() => undefined);
    await browser("close").catch(() => undefined);
    await db.$disconnect();
  }
}, 180_000);
