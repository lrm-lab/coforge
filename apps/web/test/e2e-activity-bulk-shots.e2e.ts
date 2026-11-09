import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";
import { seedActivityKeys } from "./helpers/activity-keys-seed";

/**
 * Screenshots of the Activity list for review, in en and zh-CN, light and dark, on a 1440x900
 * desktop and a 390x844 phone: the list, a hovered row with its Done tooltip (desktop: a phone has
 * no hover), the header on the Unread tab, and the Undo toast after Mark all done.
 * `ACTIVITY_SHOT_LABEL` prefixes the files, written to `/tmp/hp/activity/`.
 *
 * Opt-in like the other browser E2Es: real local Web + `agent-browser`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
/** The list's rows, under whichever day heading they sit (the list is named by its day). */
const rowItems = JSON.stringify("[data-activity-list] ol > li");
const label = Bun.env.ACTIVITY_SHOT_LABEL ?? "after";
const out = "/tmp/hp/activity";
/** The labels the shots look up, by locale. */
const doneLabel: Record<string, string> = { en: "Mark as done", "zh-CN": "标记为完成" };
const unreadTab: Record<string, string> = { en: "Unread", "zh-CN": "未读" };
const allTab: Record<string, string> = { en: "All", "zh-CN": "全部" };
const devices = [
  { name: "desktop", width: "1440", height: "900" },
  { name: "phone", width: "390", height: "844" },
] as const;

test("Activity list, Done hover, Unread header and Undo toast in each locale, theme and size", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate, waitFor } = browserSession(
    browserPath,
    `activity-bulk-shots-${process.pid}`,
  );
  const rows = `[...document.querySelectorAll(${rowItems})]`;
  const seeded = `${rows}.filter((row) => row.textContent.includes("e2e-keys"))`;
  try {
    const { workspaceId, workspace } = await db.workspaceMembership.findFirstOrThrow({
      where: { userId: DEV_BROWSER_USER.id },
      include: { workspace: { select: { slug: true } } },
    });
    await mkdir(out, { recursive: true });
    for (const device of devices) {
      await browser("set", "viewport", device.width, device.height);
      for (const locale of ["en", "zh-CN"]) {
        for (const theme of ["light", "dark"]) {
          const name = `${label}-${locale}-${theme}-${device.name}`;
          await seedActivityKeys(db, workspaceId);
          await browser("open", `${origin}/${locale}/w/${workspace.slug}/activity`);
          await waitFor(`${seeded}.length === 4 && ${pageHydrated}`, 40_000);
          await evaluate(
            `(document.documentElement.classList.toggle("dark-mode", ${theme === "dark"}), document.activeElement?.blur(), true)`,
          );
          await Bun.sleep(1_500);
          await browser("screenshot", join(out, `${name}-list.png`));

          if (device.name === "desktop") {
            // The pointer rests on the third row, over its Done check: the check floats and the
            // tooltip opens (the keyboard modality is on, as the keys shots do, since a headless
            // pointer move alone does not open it).
            await evaluate(
              `(${seeded}[2].querySelector('button[aria-label="${doneLabel[locale]}"]').setAttribute("data-shot", "done"), true)`,
            );
            await browser("hover", "[data-shot=done]");
            await browser("press", "ArrowUp");
            await evaluate(`(document.querySelector("[data-shot=done]").focus(), true)`);
            await Bun.sleep(1_000);
            await browser("screenshot", join(out, `${name}-hover.png`));
            expect(
              await evaluate<boolean>(`document.querySelector('[role="tooltip"]') !== null`),
            ).toBe(true);
            await evaluate(`(document.activeElement?.blur(), true)`);
            await browser("mouse", "move", "0", "0");
          }

          // The Unread tab.
          await browser("find", "role", "tab", "click", "--name", unreadTab[locale]);
          await Bun.sleep(800);
          await browser("screenshot", join(out, `${name}-unread.png`));
          await browser("find", "role", "tab", "click", "--name", allTab[locale]);
          await waitFor(`${seeded}.length === 4`);

          // The header's "⋯" menu, then its last item, Mark all done, and the Undo toast.
          await evaluate(
            `([...document.querySelectorAll("[data-activity-list] > div > header button")].filter((b) => b.offsetParent !== null).at(-1).click(), true)`,
          );
          await waitFor(`document.querySelectorAll('[role="menuitem"]').length > 0`);
          await Bun.sleep(400);
          await browser("screenshot", join(out, `${name}-menu.png`));
          await evaluate(
            `([...document.querySelectorAll('[role="menuitem"]')].at(-1).click(), true)`,
          );
          await waitFor(`document.querySelector("[data-sonner-toast] button") !== null`);
          await Bun.sleep(600);
          await browser("screenshot", join(out, `${name}-undo.png`));
        }
      }
    }
  } finally {
    await browser("close").catch(() => undefined);
    await db.$disconnect();
  }
}, 600_000);
