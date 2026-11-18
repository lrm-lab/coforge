import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { getComputerStatusCache } from "#src/server/centrifugo/computer-status.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";

const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.artifacts/e2e/cloud-agent-create-state");

const dialog = `document.querySelector('[role="dialog"]')`;
const dialogText = `(${dialog}?.textContent ?? "")`;
const kindSwitch = `${dialog}?.querySelector('[role="radiogroup"]')`;
const submit = `[...(${dialog}?.querySelectorAll("button") ?? [])].find((el) => el.textContent.trim() === "Create and chat")`;
const submitDisabled = `(${submit}?.disabled === true || ${submit}?.getAttribute("aria-disabled") === "true")`;
const STARTING = "Cloud computer is starting. You can create once it's ready.";
const OFFLINE = "Cloud computer is offline";

test("New Agent shows the cloud computer's state and creates only when it is ready", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `cloud-state-${process.pid}`);
  const suffix = `${process.pid}-${Date.now().toString(36)}`;
  const name = `e2e-cloud-${suffix}`;
  const { workspaceId, workspace } = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id, role: "owner" },
    orderBy: { createdAt: "asc" },
    include: { workspace: { select: { slug: true } } },
  });
  const existing = await db.computer.findFirst({
    where: { ownerId: DEV_BROWSER_USER.id, kind: "cloud", cloudSlot: "default", deletedAt: null },
    select: { id: true },
  });
  if (existing) throw new Error(`the dev user already has a default cloud computer ${existing.id}`);
  const host = await db.hostNode.create({
    data: { name: `e2e-${suffix}`, tokenHash: `e2e-${suffix}` },
  });
  const computer = await db.computer.create({
    data: {
      ownerId: DEV_BROWSER_USER.id,
      machineId: `cloud-e2e-${suffix}`,
      name: `cloud-${suffix}`,
      kind: "cloud",
      cloudSlot: "default",
    },
  });
  const computerId = computer.id;
  const shots = async (label: string) => {
    await browser("screenshot", join(artifacts, `${label}.png`));
    await evaluate(`document.documentElement.classList.add("dark-mode") ?? true`);
    await browser("screenshot", join(artifacts, `${label}-dark.png`));
    await evaluate(`document.documentElement.classList.remove("dark-mode") ?? true`);
  };
  const openNewAgent = async () => {
    await browser("open", `${origin}/en/w/${workspace.slug}`);
    await browser(
      "wait",
      "--fn",
      `${pageHydrated} && document.querySelector('button[aria-label="New"]') !== null`,
    );
    await browser("click", 'button[aria-label="New"]');
    await browser("find", "role", "menuitem", "click", "--name", "New Agent", "--exact");
    await browser("wait", "--fn", `${submit} !== undefined`);
  };
  try {
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1440", "900");

    await openNewAgent();
    await browser(
      "wait",
      "--fn",
      `[...${dialog}.querySelectorAll("button")].some((el) => el.textContent.trim() === "Claude Code" || el.textContent.trim() === "CoForge")`,
    );
    expect(await evaluate<boolean>(`${kindSwitch} === null`)).toBe(true);
    await shots("none");

    await db.workspaceComputer.create({ data: { workspaceId, computerId } });
    await openNewAgent();
    await browser("wait", "--fn", `${dialogText}.includes(${JSON.stringify(STARTING)})`);
    expect(await evaluate<boolean>(`${kindSwitch} !== null`)).toBe(true);
    expect(await evaluate<boolean>(submitDisabled)).toBe(true);
    await shots("starting");

    await db.hostJob.create({
      data: {
        hostId: host.id,
        operation: "create",
        workspaceId,
        workspaceSlug: workspace.slug,
        computerId,
        requestedByUserId: DEV_BROWSER_USER.id,
        idempotencyKey: `e2e-create-${suffix}`,
        name: computer.name,
        containerId: `coforge-${computerId}`,
        createdAt: new Date(Date.now() - 600_000),
        reportedAt: new Date(Date.now() - 600_000),
      },
    });
    await db.computer.update({ where: { id: computerId }, data: { computerVersion: "1.0.0" } });
    await browser("wait", "--fn", `${dialogText}.includes(${JSON.stringify(OFFLINE)})`);
    expect(await evaluate<boolean>(`${dialogText}.includes(${JSON.stringify(STARTING)})`)).toBe(
      false,
    );
    expect(
      await evaluate<string | null>(
        `[...${dialog}.querySelectorAll("a")].find((el) => el.textContent.trim() === "View computer")?.getAttribute("href") ?? null`,
      ),
    ).toContain(`/computer/${computerId}`);
    expect(await evaluate<boolean>(submitDisabled)).toBe(true);
    await shots("offline");
    await browser("set", "viewport", "390", "844");
    await openNewAgent();
    await browser("wait", "--fn", `${dialogText}.includes(${JSON.stringify(OFFLINE)})`);
    await shots("offline-phone");
    await browser("set", "viewport", "1440", "900");
    await openNewAgent();
    await browser("wait", "--fn", `${dialogText}.includes(${JSON.stringify(OFFLINE)})`);

    await db.computerRuntime.create({
      data: { workspaceId, computerId, provider: "pi", version: "1.0.0", displayName: "Pi" },
    });
    await getComputerStatusCache().put({ workspaceId, computerId }, true);
    await browser(
      "wait",
      "--fn",
      `${submit} !== undefined && !${submitDisabled} && !${dialogText}.includes(${JSON.stringify(OFFLINE)})`,
    );
    await shots("ready");

    await browser("fill", '[role="dialog"] input[name="name"]', name);
    await browser("click", '[role="dialog"] button[type="submit"]');
    const alert = `(${dialog}?.querySelector('[role="alert"]')?.textContent ?? "")`;
    await browser("wait", "--fn", `location.pathname.includes("/dm/") || ${alert} !== ""`);
    await browser("screenshot", join(artifacts, "created.png"));
    if (!(await evaluate<boolean>(`location.pathname.includes("/dm/")`)))
      expect(await evaluate<string>(alert)).toBe(
        "Your Agent was created, but could not start. Try again to start the same Agent.",
      );
    const agent = await db.agent.findFirstOrThrow({
      where: { name, workspaceId },
      select: { computerId: true, visibility: true },
    });
    expect(agent).toEqual({ computerId, visibility: "private" });
  } finally {
    await browser("close").catch(() => undefined);
    const agent = await db.agent.findFirst({ where: { name }, select: { id: true } });
    if (agent) {
      await db.conversation
        .deleteMany({ where: { members: { some: { agentId: agent.id } } } })
        .catch(() => undefined);
      await db.agentMessageDelivery
        .deleteMany({ where: { agentId: agent.id } })
        .catch(() => undefined);
      await db.agent.deleteMany({ where: { id: agent.id } }).catch(() => undefined);
    }
    await getComputerStatusCache()
      .put({ workspaceId, computerId }, false)
      .catch(() => undefined);
    await db.computerRuntime.deleteMany({ where: { computerId } }).catch(() => undefined);
    await db.workspaceComputer.deleteMany({ where: { computerId } }).catch(() => undefined);
    await db.hostNode.deleteMany({ where: { id: host.id } }).catch(() => undefined);
    await db.computer.deleteMany({ where: { id: computerId } }).catch(() => undefined);
    await db.$disconnect();
  }
}, 180_000);
