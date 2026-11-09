import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";
import { seedActivityKeys } from "./helpers/activity-keys-seed";

/**
 * Screenshots of the Activity list for review, at 1440x900 in en and zh-CN, light and dark: the
 * list, a row selected from the keyboard, and the Done button's tooltip. `ACTIVITY_SHOT_LABEL`
 * (before or after) prefixes the files, written to `/tmp/hp/activity/`.
 *
 * Opt-in like the other browser E2Es: real local Web + `agent-browser`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
/** The list's rows, under whichever day heading they sit (the list is named by its day). */
const rowItems = JSON.stringify("[data-activity-list] ol > li");
const label = Bun.env.ACTIVITY_SHOT_LABEL ?? "after";
const out = "/tmp/hp/activity";

test("Activity list, keyboard selection and Done tooltip in each locale and theme", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate, waitFor } = browserSession(
    browserPath,
    `activity-shots-${process.pid}`,
  );
  /** The seeded rows' links, in page order. */
  const seeded = `[...document.querySelectorAll(${rowItems})].filter((row) => row.textContent.includes("e2e-keys"))`;
  try {
    const { workspaceId, workspace } = await db.workspaceMembership.findFirstOrThrow({
      where: { userId: DEV_BROWSER_USER.id },
      include: { workspace: { select: { slug: true } } },
    });
    await seedActivityKeys(db, workspaceId);
    await mkdir(out, { recursive: true });
    await browser("set", "viewport", "1440", "900");
    for (const locale of ["en", "zh-CN"]) {
      for (const theme of ["light", "dark"]) {
        const name = `${label}-${locale}-${theme}`;
        await browser("open", `${origin}/${locale}/w/${workspace.slug}/activity`);
        await waitFor(`${seeded}.length === 4 && ${pageHydrated}`, 40_000);
        await evaluate(
          `(document.documentElement.classList.toggle("dark-mode", ${theme === "dark"}), document.activeElement?.blur(), true)`,
        );
        await Bun.sleep(400);
        await browser("screenshot", join(out, `${name}-list.png`));
        // Selected from the keyboard: the first seeded row takes focus, Down moves to the next.
        await evaluate(`(${seeded}[0].querySelector("a").focus(), true)`);
        await browser("press", "ArrowDown");
        await Bun.sleep(300);
        await browser("screenshot", join(out, `${name}-selected.png`));
        // The tooltip of the selected (or, before the change, the second) row's Done button.
        await evaluate(
          `(${seeded}[1].querySelector("button").setAttribute("data-shot", "done"), true)`,
        );
        // The pointer is over the button, and the keyboard modality is on, so the tooltip opens as
        // it does on a hover (a headless pointer move alone does not open it).
        await browser("hover", "[data-shot=done]");
        await browser("press", "ArrowUp");
        await evaluate(`(document.querySelector("[data-shot=done]").focus(), true)`);
        await Bun.sleep(1_000);
        await browser("screenshot", join(out, `${name}-tooltip.png`));
        expect(await evaluate<boolean>(`document.querySelector('[role="tooltip"]') !== null`)).toBe(
          true,
        );
      }
    }
  } finally {
    await browser("close").catch(() => undefined);
    await db.$disconnect();
  }
}, 240_000);
