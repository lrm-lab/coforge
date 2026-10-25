import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { TaskBoard } from "#src/server/tasks/task-board.server";
import { sameOriginProxy } from "./helpers/same-origin-proxy";

/** Opt-in built-Web E2E for Task assignment permissions. Requires local DATABASE_URL,
 * COFORGE_E2E_WEB_URL, COFORGE_E2E_CENTRIFUGO_URL, skip-auth dev seed and ego-browser.
 * Creates and removes one Workspace and two fixture users. Uses one browser TaskSpace;
 * artifacts: .amp/e2e/task-assignment/{member-light,admin-dark}.png. */
const databaseUrl = Bun.env.DATABASE_URL;
const web = Bun.env.COFORGE_E2E_WEB_URL;
const centrifugo = Bun.env.COFORGE_E2E_CENTRIFUGO_URL;
const browser = Bun.which("ego-browser");
if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1")
  throw new Error("DATABASE_URL must target local PostgreSQL");
if (!web || new URL(web).hostname !== "127.0.0.1")
  throw new Error("COFORGE_E2E_WEB_URL must target local Web");
if (!centrifugo) throw new Error("COFORGE_E2E_CENTRIFUGO_URL is required");
if (!browser) throw new Error("ego-browser is required");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
const proxy = sameOriginProxy(web, centrifugo);
const artifacts = join(import.meta.dir, "../../../.amp/e2e/task-assignment");
const space = "coforge-backend task127 assignment authority";
let workspaceId = "";
let people: string[] = [];
let url = "";
let reservedUrl = "";
let reservedId = "";
let ownerId = "";
let browserPassed = false;
async function runBrowser(script: string) {
  const child = Bun.spawn([browser!, "nodejs"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  child.stdin.write(script);
  child.stdin.end();
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`${stdout}\n${stderr}`);
  return `${stdout}\n${stderr}`;
}
beforeAll(async () => {
  await mkdir(artifacts, { recursive: true });
  await db.user.findUniqueOrThrow({ where: { id: DEV_BROWSER_USER.id } });
  const suffix = crypto.randomUUID();
  const [owner, peer] = await Promise.all(
    ["owner", "peer"].map((name) =>
      db.user.create({
        data: {
          username: `assign-${name}-${suffix}`,
          displayName: name === "owner" ? "Assignment owner" : "Delegation peer",
        },
      }),
    ),
  );
  people = [owner.id, peer.id];
  ownerId = owner.id;
  const workspace = await db.workspace.create({
    data: {
      slug: `assignment-ui-${suffix.slice(0, 12)}`,
      name: "Assignment UI",
      members: {
        create: [
          { userId: owner.id, role: "owner" },
          { userId: peer.id },
          { userId: DEV_BROWSER_USER.id },
        ],
      },
    },
  });
  workspaceId = workspace.id;
  const conversation = await db.conversation.create({
    data: {
      workspaceId,
      channelName: "assignment-proof",
      members: { create: [...people, DEV_BROWSER_USER.id].map((userId) => ({ userId })) },
    },
  });
  const task = (
    await new TaskBoard(db).execute(
      { workspaceId, userId: owner.id },
      {
        operation: "create",
        conversationId: conversation.id,
        idempotencyKey: crypto.randomUUID(),
        title: "Assignment capability proof",
      },
    )
  ).tasks[0];
  url = `${proxy.origin}/en/w/${workspace.slug}/channel/${conversation.id}?view=tasks&task=${task.number}`;
  const reserved = (
    await new TaskBoard(db).execute(
      { workspaceId, userId: owner.id },
      {
        operation: "create",
        conversationId: conversation.id,
        idempotencyKey: crypto.randomUUID(),
        title: "Reserved assignment proof",
        assignee: `user:${peer.id}`,
      },
    )
  ).tasks[0];
  reservedId = reserved.messageId;
  reservedUrl = `${proxy.origin}/en/w/${workspace.slug}/channel/${conversation.id}?view=tasks&task=${reserved.number}`;
});
afterAll(async () => {
  if (workspaceId) {
    await db.message.deleteMany({ where: { workspaceId } });
    await db.workspace.delete({ where: { id: workspaceId } });
  }
  await db.user.deleteMany({ where: { id: { in: people } } });
  await db.$disconnect();
  proxy.stop();
  if (browserPassed && Bun.env.COFORGE_E2E_KEEP_BROWSER !== "1")
    await runBrowser(
      `const task = await taskSpace(${JSON.stringify(space)}); await task.finish({ keep: [] });`,
    );
});
test("ordinary members can select only themselves, while Workspace admins can reserve another member", async () => {
  const ordinary = await runBrowser(`
    const task = await taskSpace(${JSON.stringify(space)});
    const page = task.page("p1");
    console.log({ spaceId: task.spaceId });
    await page.goto(${JSON.stringify(url)});
    await page.cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await page.waitForSelector('[role="dialog"] button[aria-label="Change owner: Unassigned"]', { timeout: 30000 });
    await page.click('[role="dialog"] button[aria-label="Change owner: Unassigned"]');
    await page.waitForSelector('[role="menu"][aria-label="Change owner"]');
    console.log(await page.snapshot());
    const menu = await page.evaluate(() => document.querySelector('[role="menu"][aria-label="Change owner"]').innerText);
    await page.waitForFunction(() => Array.from(document.querySelectorAll('[role="dialog"], [role="menu"]')).every((element) => !element.closest('[data-entering]') && !element.getAnimations({ subtree: true }).some((animation) => animation.playState === "running")));
    console.log(await page.screenshot({ path: ${JSON.stringify(join(artifacts, "member-light.png"))} }));
    if (!menu.includes("Dev User") || menu.includes("Delegation peer") || menu.includes("Assignment owner")) throw new Error("Ordinary member was offered another assignee: " + menu);
    await page.goto(${JSON.stringify(reservedUrl)});
    await page.waitForSelector('[role="dialog"] button[aria-label="Change owner: Delegation peer"]:disabled');
    console.log("MEMBER_SELF_ONLY");
  `);
  expect(ordinary).toContain("MEMBER_SELF_ONLY");
  await db.workspaceMembership.update({
    where: { workspaceId_userId: { workspaceId, userId: DEV_BROWSER_USER.id } },
    data: { role: "admin" },
  });
  const admin = await runBrowser(`
    const task = await taskSpace(${JSON.stringify(space)});
    const page = task.page("p1");
    await page.goto(${JSON.stringify(reservedUrl)});
    await page.cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await page.waitForSelector('[role="dialog"] button[aria-label="Change owner: Delegation peer"]', { timeout: 30000 });
    await page.click('[role="dialog"] button[aria-label="Change owner: Delegation peer"]');
    await page.waitForFunction(() => document.querySelector('[role="menu"][aria-label="Change owner"]')?.innerText.includes("Delegation peer"));
    await page.evaluate(() => { document.documentElement.classList.remove("light-mode"); document.documentElement.classList.add("dark-mode"); });
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]')?.getAnimations({ subtree: true }).some((animation) => animation.playState === "running"));
    await page.waitForFunction(() => Array.from(document.querySelectorAll('[role="dialog"], [role="menu"]')).every((element) => !element.closest('[data-entering]') && !element.getAnimations({ subtree: true }).some((animation) => animation.playState === "running")));
    console.log(await page.screenshot({ path: ${JSON.stringify(join(artifacts, "admin-dark.png"))} }));
    console.log(await page.snapshot());
    await page.click("loc=role:menuitemradio[name='Assignment owner']");
    await page.waitForSelector('[role="dialog"] button[aria-label="Change owner: Assignment owner"]');
    console.log("ADMIN_OTHER_ASSIGNEES");
  `);
  expect(admin).toContain("ADMIN_OTHER_ASSIGNEES");
  expect(
    (
      await db.task.findUniqueOrThrow({
        where: { messageId: reservedId },
        include: { owner: true },
      })
    ).owner?.userId,
  ).toBe(ownerId);
  browserPassed = true;
}, 90_000);
