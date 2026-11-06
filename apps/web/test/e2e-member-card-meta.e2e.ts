import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";

/**
 * A member card shows its Agent's name and "No computer assigned" in full at the widths people use. Seeds an
 * Agent with no Computer and removes it after the run. Screenshots, light, dark and phone, are
 * written under `.amp/e2e/member-card-meta/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/member-card-meta");

test("a member card never cuts its name or Computer line", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `member-meta-${process.pid}`);
  const suffix = `${process.pid}-${Date.now().toString(36)}`;
  const { workspaceId, workspace } = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id, role: "owner" },
    include: { workspace: { select: { slug: true } } },
  });
  const agent = await db.agent.create({
    data: {
      workspaceId,
      name: `e2e-meta-${suffix}`,
      displayName: `Meta Agent ${suffix}`,
      description: "Checks that a card's footer keeps every word.",
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
  const page = `${origin}/en/w/${workspace.slug}/members`;
  const label = `[...document.querySelectorAll("span")].find((el) => el.textContent === "No computer assigned" && el.closest('[role="row"]')?.textContent.includes(${JSON.stringify(agent.displayName)}))`;
  const cut = `(() => { const el = ${label}; return el.scrollWidth > el.clientWidth; })()`;
  const heading = `[...document.querySelectorAll("h2")].find((el) => el.textContent === ${JSON.stringify(agent.displayName)})`;
  const nameCut = `(() => { const el = ${heading}; return el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth; })()`;
  const shots = async (name: string) => {
    await browser("screenshot", join(artifacts, `${name}.png`));
    await evaluate(`document.documentElement.classList.add("dark-mode") ?? true`);
    await browser("screenshot", join(artifacts, `${name}-dark.png`));
    await evaluate(`document.documentElement.classList.remove("dark-mode") ?? true`);
  };
  try {
    await mkdir(artifacts, { recursive: true });
    for (const [width, height] of [
      [1280, 860],
      [1024, 768],
      [768, 1024],
      [390, 844],
    ]) {
      await browser("set", "viewport", String(width), String(height));
      await browser("open", page);
      await browser("wait", "--fn", `${pageHydrated} && ${label} !== undefined`);
      await evaluate(`(${label}).scrollIntoView({ block: "center" }) ?? true`);
      await browser("wait", "300");
      await shots(`w${width}`);
      expect(await evaluate<boolean>(cut)).toBe(false);
      expect(await evaluate<boolean>(nameCut)).toBe(false);
    }
  } finally {
    await browser("close").catch(() => undefined);
    await db.agent.deleteMany({ where: { id: agent.id } }).catch(() => undefined);
    await db.$disconnect();
  }
}, 120_000);
