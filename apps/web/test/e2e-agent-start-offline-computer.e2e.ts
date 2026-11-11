import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";

/**
 * Starting an Agent whose Computer is offline (task #731, after task #330): the Start button says
 * the Computer is offline before it is pressed, and a press says at once that the Agent starts when
 * the Computer reconnects, with no "Starting…" left spinning. Desktop and phone. Needs a local built
 * Web with skip-auth, PostgreSQL, Redis and agent-browser; no Daemon connects, so the Computer is
 * offline. Removes its own Workspace and Computer. Screenshots in .amp/e2e/agent-start-offline/.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
const artifacts = join(import.meta.dir, "../../../.amp/e2e/agent-start-offline");
const { browser, evaluate } = browserSession(browserPath, `agent-start-offline-${process.pid}`);
let workspaceId: string;
let workspaceSlug: string;
let computerId: string;
const agentIds: string[] = [];

beforeAll(async () => {
  await mkdir(artifacts, { recursive: true });
  await db.user.upsert({
    where: { id: DEV_BROWSER_USER.id },
    update: {},
    create: {
      id: DEV_BROWSER_USER.id,
      username: DEV_BROWSER_USER.username,
      displayName: "Start reviewer",
      welcomedAt: new Date(),
    },
  });
  const workspace = await db.workspace.create({
    data: {
      name: "Start offline",
      slug: `agent-start-offline-${process.pid}`,
      members: { create: [{ userId: DEV_BROWSER_USER.id, role: "owner" }] },
    },
  });
  workspaceId = workspace.id;
  workspaceSlug = workspace.slug;
  const computer = await db.computer.create({
    data: {
      ownerId: DEV_BROWSER_USER.id,
      machineId: `agent-start-offline-${process.pid}`,
      name: `agent-start-offline-${process.pid}.local`,
      displayName: "E2E Studio",
      kind: "local",
      workspaces: { create: { workspaceId } },
    },
  });
  computerId = computer.id;
  for (const name of ["desk", "phone"]) {
    const agent = await db.agent.create({
      data: {
        workspaceId,
        ownerId: DEV_BROWSER_USER.id,
        computerId,
        name: `start-offline-${name}`,
        displayName: `Offline ${name}`,
        runtimeConfig: {
          runtime: "pi",
          provider: { kind: "default" },
          model: "e2e-model",
          modelProvider: "e2e-provider",
          reasoning: "balanced",
        },
      },
    });
    agentIds.push(agent.id);
  }
});

afterAll(async () => {
  await browser("close").catch(() => undefined);
  if (workspaceId) await db.workspace.delete({ where: { id: workspaceId } });
  if (computerId) await db.computer.delete({ where: { id: computerId } });
  await db.$disconnect();
});

const startButton = `[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Start Agent")`;
const actions = `${startButton}?.parentElement?.textContent ?? ""`;

for (const [index, width] of [1440, 390].entries())
  test(`${width}px: Start on an offline Computer says when the Agent will start`, async () => {
    await browser("set", "viewport", String(width), "900");
    await browser(
      "open",
      `${origin}/en/w/${workspaceSlug}/members?profile=agent:${agentIds[index]}&agentTab=profile`,
    );
    await browser("wait", "--fn", `${pageHydrated} && ${startButton} != null`);
    await browser("eval", `${startButton}.scrollIntoView({ block: "center" })`);
    // Before the press: the Computer is offline, and the button still works.
    await browser("wait", "--fn", `(${actions}).includes("Computer offline")`);
    expect(await evaluate<boolean>(`${startButton}.disabled`)).toBe(false);
    await browser("screenshot", join(artifacts, `${width}-before-press.png`));
    await browser("eval", `${startButton}.click()`);
    // At once, not after the server's wait for a Daemon that is not there.
    await browser(
      "wait",
      "--fn",
      `(${actions}).includes("Starts when E2E Studio reconnects.")`,
      "--timeout",
      "1500",
    );
    await browser("screenshot", join(artifacts, `${width}-after-press.png`));
    // Long enough for the server to give up waiting and leave the Start pending.
    await browser("wait", "8000");
    const text = await evaluate<string>(actions);
    expect(text).toContain("Starts when E2E Studio reconnects.");
    expect(await evaluate<string>(`document.body.innerText`)).not.toContain("Starting…");
    await browser("screenshot", join(artifacts, `${width}-settled.png`));
  }, 90_000);
