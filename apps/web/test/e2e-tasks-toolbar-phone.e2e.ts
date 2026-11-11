import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";

/**
 * The Tasks page's toolbar on a phone: Filter, the Board/List switch and New task all fit, none
 * over another. Below `sm` the switch shows its icons only, still named for a screen reader; from
 * `sm` up it keeps its words. Screenshots go under `.amp/e2e/tasks-toolbar-phone/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/tasks-toolbar-phone");

type Box = { left: number; right: number; width: number };

test("a phone's Tasks toolbar fits Filter, the layout switch and New task side by side", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `tasks-toolbar-${process.pid}`);
  const { workspace } = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id },
    include: { workspace: { select: { slug: true } } },
  });
  // The toolbar's three controls, each a box, and the switch's words as a reader and an eye get them.
  const measure = () =>
    evaluate<{
      filter: Box;
      layout: Box;
      create: Box;
      bar: Box;
      names: string[];
      words: string;
    }>(`(() => {
      const box = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width }; };
      const layout = document.querySelector('[aria-label="Task layout"]');
      const filter = [...document.querySelectorAll("button")].find((el) => el.textContent.trim() === "Filter");
      const create = [...document.querySelectorAll("button")].find((el) => el.textContent.trim() === "New task");
      return {
        filter: box(filter),
        layout: box(layout),
        create: box(create),
        bar: box(layout.closest(".justify-between")),
        names: [...layout.querySelectorAll("button")].map((el) => el.getAttribute("aria-label")),
        words: [...layout.querySelectorAll("button")].map((el) => el.textContent.trim()).join(" "),
      };
    })()`);
  try {
    await mkdir(artifacts, { recursive: true });
    for (const width of ["390", "320", "1440"]) {
      await browser("set", "viewport", width, width === "1440" ? "900" : "844");
      await browser("open", `${origin}/en/w/${workspace.slug}/tasks?layout=list`);
      await browser(
        "wait",
        "--fn",
        `${pageHydrated} && document.querySelector('[aria-label="Task layout"]') != null`,
      );
      // A desktop browser's server render has the words; below \`sm\` they go once it hydrates.
      if (width !== "1440")
        await browser(
          "wait",
          "--fn",
          `[...document.querySelectorAll('[aria-label="Task layout"] button')].every((el) => el.textContent.trim() === "")`,
        );
      const bar = await measure();
      // Side by side and inside the bar: Filter ends before the switch starts.
      expect(bar.filter.right).toBeLessThanOrEqual(bar.layout.left);
      expect(bar.layout.right).toBeLessThanOrEqual(bar.create.left);
      expect(bar.create.right).toBeLessThanOrEqual(bar.bar.right);
      expect(bar.names).toEqual(["Board", "List"]);
      expect(bar.words).toBe(width === "1440" ? "Board List" : " ");
      await browser("screenshot", join(artifacts, `toolbar-${width}.png`));
    }
  } finally {
    await browser("close").catch(() => undefined);
    await db.$disconnect();
  }
}, 120_000);
