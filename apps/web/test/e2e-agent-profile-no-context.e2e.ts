import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";

/**
 * Task #44: the profile of an Agent its owner runs on a Computer has no "View context" entry
 * (Frank removed it). Screenshots are written under `.amp/e2e/agent-profile-no-context/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/agent-profile-no-context");

test("an owner's Agent on a Computer has no View context entry", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `profile-context-${process.pid}`);
  const tail = `${process.pid}-${Date.now()}`.slice(-10);
  const { workspaceId, workspace } = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id },
    include: { workspace: { select: { slug: true } } },
  });
  const computer = await db.computer.findFirstOrThrow({ where: { ownerId: DEV_BROWSER_USER.id } });
  const agent = await db.agent.create({
    data: {
      workspaceId,
      computerId: computer.id,
      name: `e2e-context-${tail}`,
      displayName: `Context Agent ${tail}`,
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
    await browser("set", "viewport", "1440", "900");
    await browser("open", `${origin}/en/w/${workspace.slug}/members?profile=agent:${agent.id}`);
    await browser(
      "wait",
      "--fn",
      `${pageHydrated} && [...document.querySelectorAll('button[aria-label="Message"]')].some((el) => el.offsetParent !== null)`,
    );
    await browser("wait", "1000");
    await browser("screenshot", join(artifacts, "profile.png"));
    expect(
      await evaluate<boolean>(
        `[...document.querySelectorAll("button")].some((el) => el.textContent?.trim() === "View context")`,
      ),
    ).toBe(false);
  } finally {
    await browser("close").catch(() => undefined);
    await db.agent.deleteMany({ where: { id: agent.id } }).catch(() => undefined);
    await db.$disconnect();
  }
}, 120_000);
