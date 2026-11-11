import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import {
  browserSession,
  devBrowserWorkspace,
  localBrowserE2e,
  pageHydrated,
} from "./helpers/browser-e2e";

/**
 * An Agent's profile keeps Message, Start or Stop, and Restart in its header while the panel has
 * room for them; when it does not, Message stays and the other two go in one menu.
 * Screenshots, light, dark and
 * phone, are written under `.amp/e2e/agent-profile-actions/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/agent-profile-actions");

test("a narrow profile keeps its actions in one menu", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `profile-actions-${process.pid}`);
  const tail = `${process.pid}-${Date.now()}`.slice(-10);
  const { workspaceId, workspace } = await devBrowserWorkspace(db);
  const agent = await db.agent.create({
    data: {
      workspaceId,
      name: `e2e-profile-${tail}`,
      displayName: `Profile Agent ${tail}`,
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
  const settled = () =>
    browser("wait", "--fn", `document.getAnimations().every((a) => a.playState !== "running")`);
  const shots = async (name: string) => {
    await settled();
    await browser("screenshot", join(artifacts, `${name}.png`));
    await evaluate(`document.documentElement.classList.add("dark-mode") ?? true`);
    await settled();
    await browser("screenshot", join(artifacts, `${name}-dark.png`));
    await evaluate(`document.documentElement.classList.remove("dark-mode") ?? true`);
  };
  const visible = (label: string) =>
    `[...document.querySelectorAll('button[aria-label="${label}"]')].some((el) => el.offsetParent !== null)`;
  const page = `${origin}/en/w/${workspace.slug}/members?profile=agent:${agent.id}`;
  try {
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1100", "800");
    await browser("open", page);
    await browser("wait", "--fn", `${pageHydrated} && ${visible("More actions")}`);
    // Narrow: Message stays, and the menu holds the other two.
    expect(await evaluate<boolean>(visible("Message"))).toBe(true);
    expect(await evaluate<boolean>(visible("Restart / reset"))).toBe(false);
    await shots("narrow");
    await browser("click", `button[aria-label="More actions"]`);
    await browser("wait", "--fn", `document.querySelector('[role="menu"]') !== null`);
    await shots("narrow-menu");
    await browser("press", "Escape");
    await browser("tab", "t1").catch(() => undefined);

    // Phone.
    await browser("set", "viewport", "390", "844");
    await browser("open", page);
    await browser("wait", "--fn", `${pageHydrated} && ${visible("More actions")}`);
    await shots("phone");
  } finally {
    await browser("close").catch(() => undefined);
    await db.agent.deleteMany({ where: { id: agent.id } }).catch(() => undefined);
    await db.$disconnect();
  }
}, 120_000);
