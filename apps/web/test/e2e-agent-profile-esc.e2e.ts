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
 * An Agent's profile panel closes on Escape from the document: with focus on the page or on one of
 * its tabs it closes; with the caret in one of its inline edit fields the field leaves edit mode
 * and the panel stays; with its header menu open the menu closes and the panel stays, and the next
 * Escape closes the panel. Seeds an Agent and removes it after. The last frame is under
 * `.amp/e2e/agent-profile-esc/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/agent-profile-esc");

test("Escape closes the Agent profile panel unless a field or a menu has it", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate, waitFor } = browserSession(browserPath, `profile-esc-${process.pid}`);
  const tail = `${process.pid}-${Date.now()}`.slice(-10);
  const { workspaceId, workspace } = await devBrowserWorkspace(db);
  const agent = await db.agent.create({
    data: {
      workspaceId,
      name: `e2e-profile-esc-${tail}`,
      displayName: `Esc Agent ${tail}`,
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
  const page = `${origin}/en/w/${workspace.slug}/members?profile=agent:${agent.id}`;
  const button = (label: string) => `document.querySelector('button[aria-label="${label}"]')`;
  const panelOpen = `new URL(location.href).searchParams.has("profile")`;
  const focusBody = `(document.activeElement?.blur(), document.activeElement === document.body)`;
  const open = async () => {
    await browser("open", page);
    await waitFor(`${pageHydrated} && ${panelOpen} && ${button("Edit display name")} !== null`);
  };
  try {
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1100", "800");

    await open();
    expect(await evaluate<boolean>(focusBody)).toBe(true);
    await browser("press", "Escape");
    await waitFor(`!(${panelOpen})`);

    await open();
    await evaluate(`(document.querySelector('[role="tab"]').focus(), true)`);
    await browser("press", "Escape");
    await waitFor(`!(${panelOpen})`);

    await open();
    await browser("click", `button[aria-label="Edit display name"]`);
    await waitFor(`document.activeElement?.tagName === "INPUT"`);
    await browser("screenshot", join(artifacts, "editing.png"));
    await browser("press", "Escape");
    await waitFor(`document.activeElement?.tagName !== "INPUT"`);
    await browser("wait", "500");
    expect(await evaluate<boolean>(panelOpen)).toBe(true);
    await browser("click", `button[aria-label="Edit display name"]`);
    await waitFor(`document.activeElement?.tagName === "INPUT"`);
    await evaluate(`(document.activeElement.blur(), true)`);
    await browser("press", "Escape");
    await waitFor(`!(${panelOpen})`);

    await open();
    await browser("click", `button[aria-label="More actions"]`);
    await waitFor(`document.querySelector('[role="menu"]') !== null`);
    await browser("screenshot", join(artifacts, "menu-open.png"));
    await browser("press", "Escape");
    await waitFor(`document.querySelector('[role="menu"]') === null`);
    await browser("wait", "500");
    expect(await evaluate<boolean>(panelOpen)).toBe(true);
    await evaluate(focusBody);
    await browser("press", "Escape");
    await waitFor(`!(${panelOpen})`);
    await browser("screenshot", join(artifacts, "closed.png"));
  } finally {
    await browser("close").catch(() => undefined);
    await db.agent.deleteMany({ where: { id: agent.id } }).catch(() => undefined);
    await db.$disconnect();
  }
}, 180_000);
