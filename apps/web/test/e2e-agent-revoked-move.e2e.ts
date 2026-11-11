import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";

/**
 * An Agent whose Computer's access was revoked (task #76, #coforge:#732): its Profile says so and
 * leads with the move, and the move dialog says the old Computer's files and local memory stay
 * behind instead of the usual move's list. Once the Computer is back in the Workspace the notice
 * is gone. Its own Workspace and Computers, removed after. Screenshots go under
 * .amp/e2e/agent-revoked-move/.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
const artifacts = join(import.meta.dir, "../../../.amp/e2e/agent-revoked-move");
const { browser, evaluate } = browserSession(browserPath, `agent-revoked-move-${process.pid}`);
const tail = `${process.pid}`;
let workspaceId = "";
let workspaceSlug = "";
let agentId = "";
const computerIds: string[] = [];

beforeAll(async () => {
  await mkdir(artifacts, { recursive: true });
  const workspace = await db.workspace.create({
    data: {
      name: "Revoked move",
      slug: `agent-revoked-move-${tail}`,
      members: { create: [{ userId: DEV_BROWSER_USER.id, role: "owner" }] },
    },
  });
  workspaceId = workspace.id;
  workspaceSlug = workspace.slug;
  // The Agent's Computer, no longer in the Workspace: its access was revoked.
  const old = await db.computer.create({
    data: {
      ownerId: DEV_BROWSER_USER.id,
      machineId: `revoked-old-${tail}`,
      name: "Aleksandra's MacBook Pro (Engineering)",
    },
  });
  const studio = await db.computer.create({
    data: { ownerId: DEV_BROWSER_USER.id, machineId: `revoked-new-${tail}`, name: "Studio Mac" },
  });
  computerIds.push(old.id, studio.id);
  await db.workspaceComputer.create({ data: { workspaceId, computerId: studio.id } });
  const agent = await db.agent.create({
    data: {
      workspaceId,
      ownerId: DEV_BROWSER_USER.id,
      computerId: old.id,
      name: "release-notes",
      visibility: "private",
      displayName: "Release Notes",
      runtimeConfig: {
        runtime: "pi",
        provider: { kind: "default" },
        model: "e2e-model",
        modelProvider: "e2e-provider",
        reasoning: "balanced",
      },
    },
  });
  agentId = agent.id;
});

afterAll(async () => {
  await browser("close").catch(() => undefined);
  await db.agent.deleteMany({ where: { id: agentId } }).catch(() => undefined);
  await db.workspace.deleteMany({ where: { id: workspaceId } }).catch(() => undefined);
  await db.computer.deleteMany({ where: { id: { in: computerIds } } }).catch(() => undefined);
  await db.$disconnect();
});

const text = `document.body.innerText`;
const profile = (locale: string) =>
  `${origin}/${locale}/w/${workspaceSlug}/members?profile=agent:${agentId}&agentTab=profile`;
const dark = (on: boolean) =>
  evaluate(`document.documentElement.classList.${on ? "add" : "remove"}("dark-mode") ?? true`);
const moveButton = (label: string) =>
  `[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === ${JSON.stringify(label)})`;

test("a revoked Computer's Agent is told so and moves with nothing carried over", async () => {
  for (const [width, locale, title, action, behind] of [
    ["1440", "en", "can no longer be reached", "Move to another Computer", "don't come along"],
    ["390", "zh-CN", "无法再访问", "迁移到其他电脑", "不会带到新电脑"],
  ] as const) {
    await browser("set", "viewport", width, "900");
    await browser("open", profile(locale));
    await browser("wait", "--fn", `${pageHydrated} && ${text}.includes(${JSON.stringify(title)})`);
    // The notice names the Computer; the move leads, as the one thing left to do.
    expect(
      await evaluate<boolean>(`${text}.includes("Aleksandra's MacBook Pro (Engineering)")`),
    ).toBe(true);
    expect(await evaluate<string>(`${moveButton(action)}.className`)).toContain("bg-brand-solid");
    expect(await evaluate<boolean>(`document.documentElement.scrollWidth <= innerWidth`)).toBe(
      true,
    );
    // It leads the Profile, above the Agent's name, not down under ACTIONS out of sight.
    expect(
      await evaluate<boolean>(
        `(() => { const at = (t) => [...document.querySelectorAll("p, h2, span, div")].find((el) => el.childElementCount === 0 && el.textContent.includes(t)).getBoundingClientRect().top; return at(${JSON.stringify(title)}) < at(${JSON.stringify(locale === "en" ? "Display name" : "显示名称")}); })()`,
      ),
    ).toBe(true);
    await browser("screenshot", join(artifacts, `profile-${width}-${locale}.png`));
    await dark(true);
    await browser("screenshot", join(artifacts, `profile-${width}-${locale}-dark.png`));
    await dark(false);

    // The dialog says what stays behind, not the usual move's list.
    await evaluate(`${moveButton(action)}.click() ?? true`);
    await browser(
      "wait",
      "--fn",
      `document.querySelector('[role="dialog"]')?.innerText.includes(${JSON.stringify(behind)})`,
    );
    expect(
      await evaluate<boolean>(
        `document.querySelector('[role="dialog"]').querySelectorAll("li").length === 0`,
      ),
    ).toBe(true);
    await browser("screenshot", join(artifacts, `dialog-${width}-${locale}.png`));
    await dark(true);
    await browser("screenshot", join(artifacts, `dialog-${width}-${locale}-dark.png`));
    await dark(false);
  }

  // Back in the Workspace, the Computer is the Agent's own again: no notice.
  await db.workspaceComputer.create({ data: { workspaceId, computerId: computerIds[0]! } });
  await browser("open", profile("en"));
  await browser("wait", "--fn", `${pageHydrated} && ${text}.includes("Release Notes")`);
  await browser("wait", "1500");
  expect(await evaluate<boolean>(`${text}.includes("can no longer be reached")`)).toBe(false);
}, 180_000);
