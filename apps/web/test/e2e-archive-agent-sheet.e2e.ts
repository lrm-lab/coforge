import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import {
  browserSession,
  devBrowserWorkspace,
  localBrowserE2e,
  pageHydrated,
} from "./helpers/browser-e2e";

const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/archive-agent-sheet");

test("the archive Agent confirmation is a bottom sheet on a phone", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `archive-agent-${process.pid}`);
  const { workspaceId, workspace } = await devBrowserWorkspace(db);
  const tail = `${process.pid}-${Date.now()}`.slice(-5);
  const agent = await db.agent.create({
    data: {
      workspaceId,
      name: `e2e-archive-${tail}`,
      displayName: `Archive Agent ${tail}`,
      ownerId: DEV_BROWSER_USER.id,
      runtimeConfig: {
        runtime: "pi",
        provider: { kind: "default" },
        model: "",
        modelProvider: "",
        reasoning: "",
      },
    },
  });
  try {
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "390", "844");
    await browser("open", `${origin}/en/w/${workspace.slug}/agent/${agent.id}`);
    const archive = `[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Archive Agent")`;
    await browser("wait", "--fn", `${pageHydrated} && ${archive} != null`);
    await browser("eval", `${archive}.click()`);
    await browser("wait", "--fn", `document.querySelector("[data-agent-delete-dialog]") != null`);
    await browser("wait", "500");
    const box = await evaluate<{ top: number; bottom: number }>(
      `(() => { const r = document.querySelector("[data-agent-delete-dialog]").getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; })()`,
    );
    await browser("screenshot", join(artifacts, "phone.png"));
    await evaluate(`document.documentElement.classList.add("dark-mode") ?? true`);
    await browser("wait", "300");
    await browser("screenshot", join(artifacts, "phone-dark.png"));
    expect(Math.abs(box.bottom - 844)).toBeLessThan(2);
  } finally {
    await browser("close").catch(() => undefined);
    await db.agent.deleteMany({ where: { id: agent.id } }).catch(() => undefined);
    await db.$disconnect();
  }
}, 120_000);
