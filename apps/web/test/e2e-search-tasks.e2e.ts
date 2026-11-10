import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";

/**
 * Cmd+K finds Tasks (task #46). A number is unique only inside its conversation, so `#3` lists each
 * channel's 3 with the channel the viewer is in first, and `#channel:#3` is exactly one.
 *
 * Opt-in like the other browser E2Es: real local Web, `agent-browser` and the dev seed, whose
 * #general and #product both hold a Task 3. The screenshot goes to `.amp/e2e/search-tasks/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/search-tasks");

test("search finds Tasks by title, by number across channels and by full reference", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate, waitFor } = browserSession(browserPath, `search-tasks-${process.pid}`);
  const box = 'input[type="search"]';
  const rows = `[...document.querySelectorAll("[data-search-task]")]`;
  const places = () =>
    // A channel's place is its group avatar and name (task #55); a DM's is its text.
    evaluate<string[]>(
      `${rows}.map((row) => row.querySelector("[data-channel-name]")?.textContent ?? row.innerText.split(" · ")[0].trim())`,
    );
  try {
    const [task] = await db.task.findMany({
      where: { number: 3, conversation: { channelName: "product" } },
      select: { title: true, workspace: { select: { slug: true } }, conversationId: true },
    });
    if (!task) throw new Error("the dev seed's #product Task 3 is missing");
    await browser("open", `${origin}/en/w/${task.workspace.slug}/channel/${task.conversationId}`);
    await waitFor(pageHydrated, 60_000);
    // Hydration finishes before the shortcut's listener is attached, and a press before it is
    // lost: press again until the dialog answers instead of guessing how long that takes.
    const opened = `document.querySelector('${box.replace(/'/g, "\\'")}') !== null`;
    for (let attempt = 1; ; attempt++) {
      await browser("press", "Meta+k");
      try {
        await waitFor(opened, 2_000);
        break;
      } catch (error) {
        if (attempt === 15) throw error;
      }
    }

    await browser("fill", box, "#3");
    await waitFor(`${rows}.length >= 2`);
    const found = await places();
    expect(found[0]).toBe("product");
    expect(found).toContain("general");

    await browser("fill", box, "#general:#3");
    await waitFor(
      `${rows}.length === 1 && ${rows}[0].querySelector("[data-channel-name]")?.textContent === "general"`,
    );

    await browser("fill", box, task.title.split(" ")[0]!);
    await waitFor(`${rows}.some((row) => row.innerText.includes(${JSON.stringify(task.title)}))`);
    await mkdir(artifacts, { recursive: true });
    await browser("screenshot", join(artifacts, "tasks.png"));

    await browser("fill", box, "#3");
    await waitFor(`${rows}.length >= 2`);
    await browser("press", "Enter");
    await waitFor(`new URLSearchParams(location.search).get("task") === "3"`);
    expect(await evaluate<string>("location.pathname")).toContain(task.conversationId);
  } finally {
    await browser("close").catch(() => {});
    await db.$disconnect();
  }
}, 120_000);
