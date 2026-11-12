import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { browserSession, localBrowserE2e, pageWaiter } from "./helpers/browser-e2e";

/**
 * Task #15: Settings → Account opens on the person (avatar, name, Edit), with no decorative
 * banner above it, and a field with nothing in it is not listed (no "-" placeholder). The name is
 * the heading, so it is not listed a second time as "Display name".
 *
 * Opt-in like the other browser E2Es: real local Web (`COFORGE_DEV_SKIP_AUTH=1`) + `agent-browser`
 * against the dev database. It empties the dev user's description for the run and restores it.
 * Screenshots are written under `.amp/e2e/account-settings-plain/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/account-settings-plain");

test("Account settings shows the person plainly: no banner, no empty fields", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const session = `account-plain-${process.pid}`;
  const { browser, evaluate } = browserSession(browserPath, session);
  const wait = pageWaiter(browserPath)(session, browser);
  const user = await db.user.findUniqueOrThrow({
    where: { id: DEV_BROWSER_USER.id },
    select: { description: true, displayName: true },
  });

  try {
    const membership = await db.workspaceMembership.findFirstOrThrow({
      where: { userId: DEV_BROWSER_USER.id },
      orderBy: { createdAt: "asc" },
      include: { workspace: { select: { slug: true } } },
    });
    await db.user.update({ where: { id: DEV_BROWSER_USER.id }, data: { description: "" } });
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1280", "800");
    await browser("open", `${origin}/en/w/${membership.workspace.slug}/settings?section=account`);
    // Joined is written once the page is hydrated, in the browser's time zone.
    await wait(
      `(() => { const dds = [...document.querySelectorAll("section:has(> header h2) dd:not(:has(img))")]; return dds.length > 0 && dds.every((dd) => dd.textContent.trim() !== ""); })()`,
    );

    const page = await evaluate<{
      heading: string | null;
      labels: string[];
      values: string[];
      decorative: number;
      canvases: number;
    }>(`(() => {
      const panel = document.querySelector("section:has(> header h2)");
      return {
        heading: panel.querySelector("h2").textContent.trim(),
        labels: [...panel.querySelectorAll("dt")].map((dt) => dt.textContent.trim()),
        values: [...panel.querySelectorAll("dd")].map((dd) => dd.textContent.trim()),
        decorative: panel.querySelectorAll('[aria-hidden="true"] img[alt=""]').length,
        canvases: panel.querySelectorAll("canvas").length,
      };
    })()`);
    await browser("screenshot", join(artifacts, "desktop.png"));

    expect(page.heading).toBe(user.displayName);
    expect(page.decorative).toBe(0);
    expect(page.canvases).toBe(0);
    expect(page.labels).not.toContain("Description");
    expect(page.labels).not.toContain("Display name");
    expect(page.values).not.toContain("-");
    expect(page.labels).toContain("Joined");
  } finally {
    await db.user.update({
      where: { id: DEV_BROWSER_USER.id },
      data: { description: user.description },
    });
    await browser("close").catch(() => undefined);
    await db.$disconnect();
  }
}, 120_000);
