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
    evaluate<string[]>(`${rows}.map((row) => row.innerText.split(" · ")[0].trim())`);
  try {
    const [task] = await db.task.findMany({
      where: { number: 3, conversation: { channelName: "product" } },
      select: { title: true, workspace: { select: { slug: true } }, conversationId: true },
    });
    if (!task) throw new Error("the dev seed's #product Task 3 is missing");
    await browser("open", `${origin}/en/w/${task.workspace.slug}/channel/${task.conversationId}`);
    await waitFor(pageHydrated, 60_000);
    await browser("press", "Meta+k");
    await waitFor(`document.querySelector('${box.replace(/'/g, "\\'")}') !== null`);

    await browser("fill", box, "#3");
    await waitFor(`${rows}.length >= 2`);
    const found = await places();
    expect(found[0]).toBe("#product");
    expect(found).toContain("#general");

    await browser("fill", box, "#general:#3");
    await waitFor(`${rows}.length === 1 && ${rows}[0].innerText.startsWith("#general")`);

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
