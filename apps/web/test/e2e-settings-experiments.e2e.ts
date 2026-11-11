import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";

/**
 * Settings › Experiments (task #42): the address opens the page directly, and its entry sits in the
 * Workspace group after Applications, above the System group.
 *
 * Opt-in like the other browser E2Es: real local Web and `agent-browser`. The screenshot goes to
 * `.amp/e2e/settings-experiments/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/settings-experiments");

test("settings: the experiments address opens the page, its entry in the Workspace group", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate, waitFor } = browserSession(browserPath, `exp-${process.pid}`);
  try {
    const { workspace } = await db.workspaceMembership.findFirstOrThrow({
      where: { userId: DEV_BROWSER_USER.id },
      orderBy: { createdAt: "asc" },
      include: { workspace: { select: { slug: true } } },
    });
    await browser("open", `${origin}/en/w/${workspace.slug}/settings?section=experiments`);
    await waitFor(pageHydrated, 60_000);
    await waitFor(`document.querySelector('[role="switch"], input[type="checkbox"]') !== null`);

    expect(await evaluate<string>("location.search")).toBe("?section=experiments");
    const nav = await evaluate<string>(
      `[...document.querySelectorAll("nav")].find((nav) => nav.innerText.includes("Experiments")).innerText`,
    );
    const order = ["Workspace", "Applications", "Experiments", "System"].map((label) =>
      nav.indexOf(label),
    );
    expect(order).not.toContain(-1);
    expect(order).toEqual([...order].sort((a, b) => a - b));

    await mkdir(artifacts, { recursive: true });
    await browser("screenshot", join(artifacts, "experiments.png"));
  } finally {
    await browser("close").catch(() => {});
    await db.$disconnect();
  }
}, 120_000);
