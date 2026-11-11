import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { getComputerStatusCache } from "#src/server/centrifugo/computer-status.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";

/**
 * The New Agent form starts on a runtime the chosen Computer can run, not on the CoForge runtime,
 * which needs an API key the form does not ask for. No daemon runs: the Computer and what it
 * reports are seeded and removed after the run. Screenshots, light, dark and phone, are written
 * under `.amp/e2e/agent-create-default-runtime/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/agent-create-default-runtime");

test("a new Agent starts on a runtime its Computer can run", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `agent-default-${process.pid}`);
  const suffix = `${process.pid}-${Date.now().toString(36)}`;
  const { workspaceId, workspace } = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id, role: "owner" },
    orderBy: { createdAt: "asc" },
    include: { workspace: { select: { slug: true } } },
  });
  const computer = await db.computer.create({
    data: {
      ownerId: DEV_BROWSER_USER.id,
      machineId: `default-${suffix}`,
      name: `default-${suffix}`,
      computerVersion: "1.0.53",
      platform: "linux",
    },
  });
  const computerId = computer.id;
  const shots = async (name: string) => {
    await browser("screenshot", join(artifacts, `${name}.png`));
    await evaluate(`document.documentElement.classList.add("dark-mode") ?? true`);
    await browser("screenshot", join(artifacts, `${name}-dark.png`));
    await evaluate(`document.documentElement.classList.remove("dark-mode") ?? true`);
  };
  try {
    await db.workspaceComputer.create({ data: { workspaceId, computerId } });
    await db.computerRuntime.create({
      data: {
        workspaceId,
        computerId,
        provider: "claude-code",
        version: "1.0.0",
        displayName: "Claude Code",
      },
    });
    await getComputerStatusCache().put({ workspaceId, computerId }, true);
    await mkdir(artifacts, { recursive: true });

    for (const [width, height, label] of [
      ["1440", "900", "desktop"],
      ["390", "844", "phone"],
    ] as const) {
      await browser("set", "viewport", width, height);
      await browser("open", `${origin}/en/w/${workspace.slug}`);
      await browser(
        "wait",
        "--fn",
        `${pageHydrated} && document.querySelector('button[aria-label="New"]') !== null`,
      );
      await browser("click", 'button[aria-label="New"]');
      await browser("find", "role", "menuitem", "click", "--name", "New Agent", "--exact");
      await browser("find", "role", "radio", "click", "--name", "Local Computer", "--exact");
      await browser(
        "wait",
        "--fn",
        `[...document.querySelectorAll('[role="dialog"] button')].some((button) => button.textContent.includes("Claude Code"))`,
      );
      await browser("wait", "500");
      const page = await browser("snapshot");
      expect(page).toContain("Claude Code Runtime");
      expect(page).not.toContain("CoForge Runtime");
      await shots(label);
    }
  } finally {
    await browser("close").catch(() => undefined);
    await getComputerStatusCache()
      .put({ workspaceId, computerId }, false)
      .catch(() => undefined);
    await db.computerRuntime.deleteMany({ where: { computerId } }).catch(() => undefined);
    await db.workspaceComputer.deleteMany({ where: { computerId } }).catch(() => undefined);
    await db.computer.deleteMany({ where: { id: computerId } }).catch(() => undefined);
    await db.$disconnect();
  }
}, 120_000);
