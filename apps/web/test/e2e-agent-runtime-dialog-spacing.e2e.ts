import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { agentDirectKey } from "#src/features/conversations/direct-key";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";

/**
 * The Agent's runtime configuration dialog on a phone (task #coforge-ui:#21): with the environment
 * variables folded under "More", only the dialog's own rhythm sits between that line and the
 * buttons. Seeds a Computer and an Agent and removes them after the run. Screenshots, light and
 * dark, are under `.amp/e2e/agent-runtime-dialog-spacing/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/agent-runtime-dialog-spacing");

test("the runtime configuration dialog keeps its closed More close to the buttons", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `runtime-dialog-${process.pid}`);
  const suffix = `${process.pid}-${Date.now().toString(36)}`;
  const { workspaceId, workspace } = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id, role: "owner" },
    include: { workspace: { select: { slug: true } } },
  });
  const computer = await db.computer.create({
    data: {
      ownerId: DEV_BROWSER_USER.id,
      machineId: `e2e-dialog-${suffix}`,
      name: `e2e-dialog-${suffix}.local`,
      displayName: "E2E Studio",
      kind: "local",
      workspaces: { create: { workspaceId } },
    },
  });
  const agent = await db.agent.create({
    data: {
      workspaceId,
      computerId: computer.id,
      name: `e2e-dialog-${suffix}`,
      displayName: "Dorothy",
      ownerId: DEV_BROWSER_USER.id,
      runtimeConfig: {
        runtime: "cursor",
        provider: { kind: "default" },
        model: "",
        modelProvider: "",
        reasoning: "",
      },
    },
  });
  const channel = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `e2e-dialog-${suffix}`,
      description: "",
      members: { create: [{ userId: DEV_BROWSER_USER.id }, { agentId: agent.id }] },
    },
  });
  const direct = await db.conversation.create({
    data: {
      workspaceId,
      directKey: agentDirectKey(DEV_BROWSER_USER.id, agent.id),
      members: { create: [{ userId: DEV_BROWSER_USER.id }, { agentId: agent.id }] },
    },
  });

  const press = async (selector: string) => {
    await evaluate(`(${selector}.setAttribute("data-press", ""), true)`);
    await browser("click", "[data-press]");
    await evaluate(`(document.querySelector("[data-press]")?.removeAttribute("data-press"), true)`);
  };
  try {
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "390", "844");
    await browser("open", `${origin}/en/w/${workspace.slug}/dm/${direct.id}`);
    const profile = `[...document.querySelectorAll("button")].find((b) => b.querySelector("h1"))`;
    await browser("wait", "--fn", `${pageHydrated} && ${profile} != null`);
    await press(profile);
    const pencil = `document.querySelector('button[aria-label="Edit Runtime Configuration"]')`;
    await browser("wait", "--fn", `${pencil} != null`);
    await press(pencil);
    await browser("wait", "--fn", `document.querySelector('[role="dialog"] form') != null`);
    await browser("wait", "1500");
    // From the bottom of "More" to the top of the buttons: the body's 8 and the footer's 16.
    const gap = await evaluate<number>(`(() => {
      const form = document.querySelector('[role="dialog"] form');
      const more = [...form.querySelectorAll("button")].find((b) => b.textContent.trim() === "More");
      const actions = form.lastElementChild;
      return Math.round(actions.getBoundingClientRect().top - more.getBoundingClientRect().bottom);
    })()`);
    expect(gap).toBeLessThanOrEqual(28);
    await browser("screenshot", join(artifacts, "dialog.png"));
    await evaluate(`(document.documentElement.classList.add("dark-mode"), true)`);
    await browser("wait", "300");
    await browser("screenshot", join(artifacts, "dialog-dark.png"));
  } finally {
    await browser("close").catch(() => undefined);
    await db.conversation
      .deleteMany({ where: { id: { in: [channel.id, direct.id] } } })
      .catch(() => undefined);
    await db.agent.delete({ where: { id: agent.id } }).catch(() => undefined);
    await db.computer.delete({ where: { id: computer.id } }).catch(() => undefined);
    await db.$disconnect();
  }
}, 180_000);
