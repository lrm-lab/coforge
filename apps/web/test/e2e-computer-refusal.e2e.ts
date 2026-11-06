import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { getComputerConnectRefusals } from "#src/server/centrifugo/computer-connect-refusals.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";

/**
 * A Computer CoForge refuses for good says why, on the list and on its page, and what moves it on
 * (task #603): the owner of a local Computer gets the command, of a cloud Computer Reconnect, and
 * anyone else is pointed at the owner. Once the refusal is cleared the page reads as before.
 * Screenshots at desktop and phone, light and dark, under `.amp/e2e/computer-refusal/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/computer-refusal");
const prefix = Bun.env.SHOT_PREFIX ?? "refusal";

test("a refused Computer says why on the list and its page, and recovers when cleared", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `refusal-${process.pid}`);
  const refusals = getComputerConnectRefusals();
  const suffix = `${process.pid}-${Date.now()}`;
  const { workspace } = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id, role: "owner" },
    include: { workspace: true },
  });
  const other = await db.user.create({
    data: { username: `refusal-${suffix}`, displayName: "Lin Xia" },
  });
  await db.workspaceMembership.create({
    data: { userId: other.id, workspaceId: workspace.id, role: "member" },
  });
  const seed = (machineId: string, displayName: string, ownerId: string, kind = "local") =>
    db.computer.create({
      data: {
        ownerId,
        machineId: `${machineId}-${suffix}`,
        name: `${machineId}.local`,
        displayName,
        kind,
        workspaces: { create: { workspaceId: workspace.id } },
      },
    });
  const local = await seed("refused-local", "Studio Mac", DEV_BROWSER_USER.id);
  const cloud = await seed("refused-cloud", "Cloud box", DEV_BROWSER_USER.id, "cloud");
  const theirs = await seed("refused-theirs", "Lin's laptop", other.id);
  const theirsCloud = await seed("refused-theirs-cloud", "Lin's cloud", other.id, "cloud");
  const scope = (computerId: string) => ({ workspaceId: workspace.id, computerId });
  try {
    await mkdir(artifacts, { recursive: true });
    await refusals.record(scope(local.id), "credential_revoked");
    await refusals.record(scope(cloud.id), "credential_revoked");
    await refusals.record(scope(theirs.id), "computer_unlinked");
    await refusals.record(scope(theirsCloud.id), "computer_unlinked");

    const open = async (computerId: string) => {
      await browser("open", `${origin}/en/w/${workspace.slug}/computer/${computerId}`);
      await browser("wait", "--fn", pageHydrated);
    };
    const alertText = () =>
      evaluate<string>(`document.querySelector('[role="alert"]')?.textContent ?? ""`);
    const listText = () => evaluate<string>(`document.querySelector("nav ul").textContent`);
    const shot = async (name: string) => {
      const settled = `document.getAnimations().every((animation) => !(animation instanceof CSSTransition) || animation.playState !== "running")`;
      await browser("wait", "--fn", settled);
      await browser("screenshot", join(artifacts, `${prefix}-${name}.png`));
      await evaluate(`document.documentElement.classList.add("dark-mode") ?? true`);
      await browser("wait", "--fn", settled);
      await browser("screenshot", join(artifacts, `${prefix}-${name}-dark.png`));
      await evaluate(`document.documentElement.classList.remove("dark-mode") ?? true`);
    };

    await browser("set", "viewport", "1440", "900");
    await open(local.id);
    expect(await listText()).toContain("Credential revoked");
    expect(await listText()).toContain("Removed from Workspace");
    const owned = await alertText();
    expect(owned).toContain("This Computer's credential was revoked");
    expect(owned).toContain(`coforge-computer detach --workspace ${workspace.slug}`);
    expect(owned).toContain(`coforge-computer setup --workspace ${workspace.slug}`);
    expect(owned).not.toContain("Reconnect");
    await shot("local-1440");

    await open(cloud.id);
    const hosted = await alertText();
    expect(hosted).toContain("This Computer's credential was revoked");
    expect(hosted).not.toContain("coforge-computer");
    expect(hosted).toContain("Reconnect");
    await shot("cloud-1440");

    await open(theirs.id);
    const foreign = await alertText();
    expect(foreign).toContain("This Computer was removed from this Workspace");
    expect(foreign).toContain("Its owner can connect it again.");
    expect(foreign).not.toContain("coforge-computer");

    // Reconnecting cannot mend a removed cloud Computer, so no one is told it can.
    await open(theirsCloud.id);
    expect(await alertText()).not.toContain("Its owner can connect it again.");

    await browser("set", "viewport", "390", "844");
    await open(local.id);
    await shot("local-390");

    await refusals.clear(scope(local.id));
    await browser("set", "viewport", "1440", "900");
    await open(local.id);
    expect(await alertText()).toBe("");
  } finally {
    for (const { id } of [local, cloud, theirs, theirsCloud]) {
      await refusals.clear(scope(id));
      await db.computer.delete({ where: { id } });
    }
    await db.user.delete({ where: { id: other.id } });
    await browser("close").catch(() => undefined);
    await db.$disconnect();
  }
}, 120_000);
