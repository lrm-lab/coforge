import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { getComputerStatusCache } from "#src/server/centrifugo/computer-status.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";

const { origin, browserPath, databaseUrl } = localBrowserE2e();
const dialog = `document.querySelector('[role="dialog"]')`;
const usernameInput = `${dialog}?.querySelector('input[name="name"]')`;
const placeholder = `${dialog}?.querySelector('[role="status"][aria-label="Loading…"]')`;
const tab = (label: string) =>
  `[...(${dialog}?.querySelectorAll('[role="radiogroup"] label') ?? [])].find((el) => el.textContent.trim() === ${JSON.stringify(label)})`;
const localFormReady = `${dialog}?.querySelector('input[placeholder="Search models"]:not([disabled])') != null`;
const delayServerFunctions = `(() => {
  if (!window.__e2eFetch) {
    window.__e2eFetch = window.fetch;
    window.fetch = async (...args) => {
      const url = String(args[0] instanceof Request ? args[0].url : args[0]);
      if (window.__e2eHold && url.includes("/_serverFn/")) await window.__e2eHold;
      return window.__e2eFetch(...args);
    };
  }
  window.__e2eHold = new Promise((resolve) => { window.__e2eRelease = resolve; });
  return true;
})()`;

const artifacts = join(import.meta.dir, "../../../.amp/e2e/agent-create-default-runtime");

test("a new Agent starts on a runtime its Computer can run, keeps its username across tabs and waits in its own shape", async () => {
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
  const waitFor = (condition: string) => browser("wait", "--fn", condition);
  const click = (element: string) => evaluate(`${element}.click() ?? true`);
  const openNewAgent = async () => {
    await browser("click", 'button[aria-label="New"]');
    await browser("find", "role", "menuitem", "click", "--name", "New Agent", "--exact");
    await waitFor(`${dialog} != null`);
  };
  const closeDialog = async () => {
    await browser("press", "Escape");
    await waitFor(`${dialog} == null`);
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
    await browser("set", "viewport", "1440", "900");
    await browser("open", `${origin}/en/w/${workspace.slug}`);
    await waitFor(`${pageHydrated} && document.querySelector('button[aria-label="New"]') !== null`);
    await openNewAgent();
    await waitFor(`${tab("Local")} != null`);
    await click(tab("Local"));
    await waitFor(localFormReady);
    await browser("fill", '[role="dialog"] input[name="name"]', "keep-me");
    await click(tab("External"));
    await waitFor(
      `${usernameInput}?.value === "keep-me" && ${tab("External")}?.querySelector("input")?.checked`,
    );
    const placeholderOnReturn = JSON.parse(
      await browser(
        "eval",
        `(async () => {
      ${tab("Local")}.click();
      let seen = false;
      for (let frame = 0; frame < 10; frame++) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        if (${placeholder}) seen = true;
      }
      return seen;
    })()`,
      ),
    );
    expect(placeholderOnReturn).toBe(false);
    await waitFor(localFormReady);
    expect(await evaluate<string>(`${usernameInput}.value`)).toBe("keep-me");
    await closeDialog();

    await browser("set", "viewport", "1440", "1400");
    await evaluate(delayServerFunctions);
    await openNewAgent();
    await waitFor(`${placeholder} != null && getComputedStyle(${placeholder}).opacity === "1"`);
    const waitingHeight = await evaluate<number>(`${dialog}.getBoundingClientRect().height`);
    await evaluate(`window.__e2eRelease() ?? true`);
    await waitFor(localFormReady);
    await browser("wait", "300");
    const formHeight = await evaluate<number>(`${dialog}.getBoundingClientRect().height`);
    expect(Math.abs(formHeight - waitingHeight)).toBeLessThanOrEqual(1);
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
