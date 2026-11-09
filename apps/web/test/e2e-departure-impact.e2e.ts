import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { generalChannelForCreator } from "#src/server/conversations/general-channel.server";
import {
  browserSession,
  localBrowserE2e,
  menuItemNamed,
  pageHydrated,
} from "./helpers/browser-e2e";

/**
 * The Remove member and Leave Workspace confirmations say which Computers disconnect and how many
 * Agents on them go offline. Seeds three Workspaces where the dev user is an admin, one per case
 * (Computers with Agents, Computers only, none), each with a member who owns Computers there, and
 * removes them after the run. The check that is under way, and one that failed, are forced by
 * holding or failing the page's server function requests. Screenshots, English and Chinese at
 * desktop and phone size, are written under `/tmp/hp/745/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = "/tmp/hp/745";
type Locale = "en" | "zh-CN";
type Case = "agents" | "computers" | "none";

const expected = {
  agents: {
    en: {
      remove:
        "Removing Bob Stone disconnects 4 Computers from this Workspace: Bob Desk, Bob Laptop, Bob NAS and 1 other. 5 Agents on them go offline too: Atlas, Birch, Cedar and 2 more.",
      leave:
        "Leaving disconnects the 2 Computers you attached from this Workspace: Dev Mac and Dev Pi. 1 Agent on them goes offline too: Fern.",
    },
    "zh-CN": {
      remove:
        "移除 Bob Stone 会让 4 台 Computer 与这个工作区断开连接：Bob Desk、Bob Laptop、Bob NAS，还有 1 台。5 个 Agent 会一起离线：Atlas、Birch、Cedar，还有 2 个。",
      leave:
        "离开后，你在这里接入的 2 台 Computer 会与这个工作区断开连接：Dev Mac、Dev Pi。1 个 Agent 会一起离线：Fern。",
    },
  },
  computers: {
    en: {
      remove: "Removing Bob Stone disconnects 1 Computer from this Workspace: Bob Desk.",
      leave: "Leaving disconnects the 1 Computer you attached from this Workspace: Dev Mac.",
    },
    "zh-CN": {
      remove: "移除 Bob Stone 会让 1 台 Computer 与这个工作区断开连接：Bob Desk。",
      leave: "离开后，你在这里接入的 1 台 Computer 会与这个工作区断开连接：Dev Mac。",
    },
  },
} as const;
const labels = {
  en: { remove: "Remove", leave: "Leave Workspace", retry: "Try again" },
  "zh-CN": { remove: "移除", leave: "离开工作区", retry: "重试" },
} as const;

test("a departure's confirmation lists the Computers it disconnects", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate, waitFor, clickText } = browserSession(
    browserPath,
    `departure-impact-${process.pid}`,
  );
  const suffix = `${process.pid}-${Date.now().toString(36)}`;
  const userIds: string[] = [];
  const workspaceIds: string[] = [];
  const computerIds: string[] = [];
  const runtimeConfig = {
    runtime: "pi",
    provider: { kind: "default" },
    model: "",
    modelProvider: "",
    reasoning: "",
  };

  async function seed(kind: Case) {
    const user = (displayName: string) =>
      db.user.create({
        data: { displayName, username: `e2e-dep-${kind}-${displayName.split(" ")[0]}-${suffix}` },
      });
    const olive = await user("Olive Reed");
    const bob = await user("Bob Stone");
    userIds.push(olive.id, bob.id);
    const workspace = await db.workspace.create({
      data: {
        slug: `e2e-departure-${kind}-${suffix}`,
        name: `Departure ${kind}`,
        members: {
          create: [
            { userId: olive.id, role: "owner" },
            { userId: DEV_BROWSER_USER.id, role: "admin" },
            { userId: bob.id, role: "member" },
          ],
        },
        conversations: generalChannelForCreator(olive.id),
      },
    });
    workspaceIds.push(workspace.id);
    const computer = async (ownerId: string, name: string) => {
      const row = await db.computer.create({
        data: { ownerId, name, machineId: `machine-${crypto.randomUUID()}` },
      });
      computerIds.push(row.id);
      await db.workspaceComputer.create({
        data: { workspaceId: workspace.id, computerId: row.id },
      });
      return row;
    };
    const agent = (ownerId: string, computerId: string, displayName: string) =>
      db.agent.create({
        data: {
          workspaceId: workspace.id,
          name: `e2e-${displayName.toLowerCase()}-${suffix}`,
          displayName,
          ownerId,
          computerId,
          runtimeConfig,
        },
      });
    if (kind === "agents") {
      const desk = await computer(bob.id, "Bob Desk");
      const laptop = await computer(bob.id, "Bob Laptop");
      await computer(bob.id, "Bob NAS");
      await computer(bob.id, "Bob Pi");
      await agent(bob.id, desk.id, "Atlas");
      await agent(bob.id, desk.id, "Birch");
      await agent(bob.id, laptop.id, "Cedar");
      await agent(bob.id, laptop.id, "Dune");
      await agent(bob.id, laptop.id, "Ember");
      const mac = await computer(DEV_BROWSER_USER.id, "Dev Mac");
      await computer(DEV_BROWSER_USER.id, "Dev Pi");
      await agent(DEV_BROWSER_USER.id, mac.id, "Fern");
    } else if (kind === "computers") {
      await computer(bob.id, "Bob Desk");
      await computer(DEV_BROWSER_USER.id, "Dev Mac");
    }
    return workspace.slug;
  }

  /** Holds ("hang") or fails ("fail") every server function GET the page makes, or lets it through. */
  const serverFns = (mode: "hang" | "fail" | "off") =>
    evaluate<boolean>(`(() => {
      if (!window.__realFetch) {
        window.__realFetch = window.fetch.bind(window);
        window.__fnMode = "off";
        window.fetch = (input, init) => {
          const url = String(input instanceof Request ? input.url : input);
          const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
          if (window.__fnMode !== "off" && method === "GET" && url.includes("/_serverFn/"))
            return window.__fnMode === "hang"
              ? new Promise(() => {})
              : Promise.reject(new TypeError("forced failure"));
          return window.__realFetch(input, init);
        };
      }
      window.__fnMode = ${JSON.stringify(mode)};
      return true;
    })()`);
  // The member menu's popover is a dialog too; the confirmation is the one without a menu.
  const dialog = `[...document.querySelectorAll('[role="alertdialog"], [role="dialog"]')].find((node) => !node.querySelector('[role="menu"]'))`;
  const dialogText = () => evaluate<string>(`(${dialog})?.textContent ?? ""`);
  const confirmDisabled = () =>
    evaluate<boolean>(`[...(${dialog}).querySelectorAll("button")].at(-1).disabled`);
  const settled = `(${dialog}) && !(${dialog}).querySelector('[data-testid="departure-impact-loading"]')`;

  async function openRemove(base: string, locale: Locale) {
    await browser("open", `${base}/settings?section=members`);
    await waitFor(`${pageHydrated} && document.body.textContent.includes("Bob Stone")`, 60_000);
    const row = `[...document.querySelectorAll("li")].find((li) => li.textContent.includes("Bob Stone"))`;
    await evaluate(`${row}.querySelector('button[aria-label]').click() ?? true`);
    await waitFor(`document.querySelector('[role="menu"]') !== null`);
    await waitFor(`${menuItemNamed(labels[locale].remove)} !== undefined`);
    await evaluate(`${menuItemNamed(labels[locale].remove)}.click() ?? true`);
    await waitFor(`(${dialog}) !== undefined`);
  }
  async function openLeave(base: string, locale: Locale) {
    await browser("open", `${base}/settings?section=workspace-profile`);
    await waitFor(pageHydrated, 60_000);
    await clickText("button", labels[locale].leave);
    await waitFor(`(${dialog}) !== undefined`);
  }
  const shot = async (name: string) => browser("screenshot", join(artifacts, `${name}.png`));

  try {
    await mkdir(artifacts, { recursive: true });
    const slugs = {
      agents: await seed("agents"),
      computers: await seed("computers"),
      none: await seed("none"),
    };

    for (const [locale, width, height, device] of [
      ["en", 1440, 900, "desktop"],
      ["zh-CN", 1440, 900, "desktop"],
      ["en", 390, 844, "phone"],
      ["zh-CN", 390, 844, "phone"],
    ] as const) {
      await browser("set", "viewport", String(width), String(height));
      for (const kind of ["agents", "computers", "none"] as const) {
        const base = `${origin}/${locale}/w/${slugs[kind]}`;
        for (const action of ["remove", "leave"] as const) {
          await (action === "remove" ? openRemove : openLeave)(base, locale);
          await waitFor(settled, 30_000);
          const text = await dialogText();
          if (kind === "none") {
            expect(text).not.toContain(locale === "en" ? "disconnects" : "断开连接");
            expect(text).not.toContain("Agent on them");
          } else {
            expect(text).toContain(expected[kind][locale][action]);
          }
          expect(await confirmDisabled()).toBe(false);
          // The screenshots show the dialog the way the first look gets it.
          await browser("wait", "300");
          await shot(`${action}-${kind}-${locale}-${device}`);
        }
      }
    }

    // The check under way holds Confirm; one that failed keeps it, and Try again asks again.
    await browser("set", "viewport", "1440", "900");
    const base = `${origin}/en/w/${slugs.agents}`;
    await browser("open", `${base}/settings?section=members`);
    await waitFor(`${pageHydrated} && document.body.textContent.includes("Bob Stone")`, 60_000);
    await serverFns("hang");
    const row = `[...document.querySelectorAll("li")].find((li) => li.textContent.includes("Bob Stone"))`;
    await evaluate(`${row}.querySelector('button[aria-label]').click() ?? true`);
    await waitFor(`${menuItemNamed("Remove")} !== undefined`);
    await evaluate(`${menuItemNamed("Remove")}.click() ?? true`);
    await waitFor(
      `(${dialog})?.textContent.includes("Checking which Computers this disconnects…")`,
    );
    expect(await confirmDisabled()).toBe(true);
    await shot("remove-loading-en-desktop");

    await serverFns("fail");
    await evaluate(`(${dialog}).querySelector("button").click() ?? true`);
    await waitFor(`!(${dialog})`);
    await evaluate(`${row}.querySelector('button[aria-label]').click() ?? true`);
    await waitFor(`${menuItemNamed("Remove")} !== undefined`);
    await evaluate(`${menuItemNamed("Remove")}.click() ?? true`);
    await waitFor(`Boolean((${dialog})?.querySelector('[data-testid="departure-impact-failed"]'))`);
    expect(await dialogText()).toContain(
      "Couldn't check which Computers this disconnects from this Workspace.",
    );
    expect(await confirmDisabled()).toBe(false);
    await shot("remove-failed-en-desktop");

    await serverFns("off");
    await clickText("button", "Try again");
    await waitFor(`Boolean((${dialog})?.querySelector('[data-testid="departure-impact"]'))`);
    expect(await dialogText()).toContain(expected.agents.en.remove);
  } finally {
    await browser("close").catch(() => undefined);
    await db.workspace.deleteMany({ where: { id: { in: workspaceIds } } }).catch(() => undefined);
    await db.computer.deleteMany({ where: { id: { in: computerIds } } }).catch(() => undefined);
    await db.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
    await db.$disconnect();
  }
}, 600_000);
