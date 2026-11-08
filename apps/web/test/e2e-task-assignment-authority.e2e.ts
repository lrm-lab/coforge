import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { TaskBoard } from "#src/server/tasks/task-board.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";

/** Built-Web E2E for Task assignment permissions, in agent-browser. Requires local DATABASE_URL,
 * COFORGE_E2E_WEB_URL and the skip-auth dev seed. Creates and removes one Workspace and two
 * fixture users. Artifacts: .amp/e2e/task-assignment/{member-light,admin-dark}.png. */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
const artifacts = join(import.meta.dir, "../../../.amp/e2e/task-assignment");
const { browser, evaluate, waitFor } = browserSession(
  browserPath,
  `assign-authority-${process.pid}`,
);
let workspaceId = "";
let people: string[] = [];
let url = "";
let reservedUrl = "";
let reservedId = "";
let ownerId = "";
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
  url = `${origin}/en/w/${workspace.slug}/channel/${conversation.id}?view=tasks&task=${task.number}`;
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
  reservedId = reserved.id;
  reservedUrl = `${origin}/en/w/${workspace.slug}/channel/${conversation.id}?view=tasks&task=${reserved.number}`;
});
afterAll(async () => {
  if (workspaceId) {
    await db.message.deleteMany({ where: { workspaceId } });
    await db.workspace.delete({ where: { id: workspaceId } });
  }
  await db.user.deleteMany({ where: { id: { in: people } } });
  await db.$disconnect();
  await browser("close").catch(() => undefined);
});
test("ordinary members can select only themselves, while Workspace admins can reserve another member", async () => {
  const owner = (name: string) =>
    `document.querySelector('[role="dialog"] button[aria-label="Change owner: ${name}"]')`;
  const menu = `document.querySelector('[role="menu"][aria-label="Change owner"]')`;
  const settled = `[...document.querySelectorAll('[role="dialog"], [role="menu"]')].every((element) => !element.closest("[data-entering]") && !element.getAnimations({ subtree: true }).some((animation) => animation.playState === "running"))`;
  await browser("set", "viewport", "1440", "1000");

  // An ordinary member is offered only themselves, and cannot change a Task held by another.
  await browser("open", url);
  await waitFor(`${pageHydrated} && ${owner("Unassigned")} != null`, 60_000);
  await browser("eval", `${owner("Unassigned")}.click()`);
  await waitFor(`${menu} != null`);
  await waitFor(settled);
  const offered = await evaluate<string>(`${menu}.innerText`);
  await browser("screenshot", join(artifacts, "member-light.png"));
  expect(offered).toContain("Dev User");
  expect(offered).not.toContain("Delegation peer");
  expect(offered).not.toContain("Assignment owner");
  await browser("open", reservedUrl);
  await waitFor(`${pageHydrated} && ${owner("Delegation peer")}?.disabled === true`, 60_000);

  // A Workspace admin may give it to another member.
  await db.workspaceMembership.update({
    where: { workspaceId_userId: { workspaceId, userId: DEV_BROWSER_USER.id } },
    data: { role: "admin" },
  });
  await browser("open", reservedUrl);
  await waitFor(`${pageHydrated} && ${owner("Delegation peer")}?.disabled === false`, 60_000);
  await browser("eval", `${owner("Delegation peer")}.click()`);
  await waitFor(`(${menu}?.innerText ?? "").includes("Delegation peer")`);
  await evaluate(
    `(document.documentElement.classList.remove("light-mode"), document.documentElement.classList.add("dark-mode"), true)`,
  );
  await waitFor(settled);
  await browser("screenshot", join(artifacts, "admin-dark.png"));
  await browser(
    "eval",
    `[...${menu}.querySelectorAll('[role="menuitemradio"]')].find((item) => item.textContent.includes("Assignment owner")).click()`,
  );
  await waitFor(`${owner("Assignment owner")} != null`);
  expect(
    (
      await db.task.findUniqueOrThrow({
        where: { id: reservedId },
        include: { owner: true },
      })
    ).owner?.userId,
  ).toBe(ownerId);
}, 90_000);
