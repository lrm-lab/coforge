import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";

/**
 * A channel's members as a page inside its settings panel, in a real browser. The Members summary
 * opens the page in place of the settings (Back returns to them): the members grouped by humans
 * and Agents, a search that narrows them, and "Add member", which opens the add view in the same
 * page. Picking an Agent there and adding it puts it in the list; making it a channel admin
 * changes its role; removing it again asks first, and nothing changes before the confirmation.
 * Every role badge ends on one line and a plain member shows none; on a phone each row keeps its
 * actions behind one menu button, so the name keeps its width.
 *
 * Opt-in like the other browser E2Es: real local Web + `agent-browser`, the dev user an owner of
 * its Workspace with a Computer attached (seed-dev). Each run seeds a fresh channel with one fresh
 * Agent in it and another outside it, and removes them afterwards. Screenshots are written under
 * `.amp/e2e/channel-members-page/`.
 */
const origin = Bun.env.COFORGE_E2E_WEB_URL;
if (!origin || !["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  throw new Error("COFORGE_E2E_WEB_URL must target the local Web service");
const browserPath = Bun.which("agent-browser");
if (!browserPath) throw new Error("agent-browser is required");
const databaseUrl = Bun.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1")
  throw new Error("DATABASE_URL must target local PostgreSQL");
const artifacts = join(import.meta.dir, "../../../.amp/e2e/channel-members-page");

test("the settings panel shows a channel's members as a page, adds and removes one", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const session = `channel-members-page-${process.pid}`;
  async function browser(...args: string[]) {
    const child = Bun.spawn([browserPath!, "--session", session, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(`Browser ${args[0]} failed: ${stderr}`);
    return stdout;
  }
  async function evaluate<T>(expression: string): Promise<T> {
    return JSON.parse(JSON.parse(await browser("eval", `JSON.stringify(${expression})`))) as T;
  }
  /** Waits for `condition`, failing with its text rather than at the test timeout; a first page
   * load compiles on the dev server, so it gets longer. */
  const waitFor = (condition: string, ms = 20_000) =>
    Promise.race([
      browser("wait", "--fn", condition),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`timed out waiting for ${condition}`)), ms),
      ),
    ]);
  const byText = (selector: string, text: string) =>
    `[...document.querySelectorAll(${JSON.stringify(selector)})].filter((element) => element.textContent.trim() === ${JSON.stringify(text)}).at(-1)`;
  async function clickText(selector: string, text: string) {
    await waitFor(`${byText(selector, text)} !== undefined`);
    const clicked = await browser(
      "eval",
      `(() => { const target = ${byText(selector, text)}; target?.click(); return Boolean(target); })()`,
    );
    if (!clicked.includes("true")) throw new Error(`"${text}" disappeared before it was clicked`);
  }
  const panel = `document.querySelector('[role="dialog"][aria-label="Channel details and settings"]')`;
  const panelHas = (text: string) => `${panel}?.textContent.includes(${JSON.stringify(text)})`;
  const onRoster = `${panel}?.querySelector('input[placeholder="Search members…"]') != null`;
  async function openChannel(path: string) {
    await browser("open", `${origin}${path}`);
    await waitFor(
      `document.querySelector('[aria-label="Channel details and settings"]') !== null`,
      60_000,
    );
    // A click that lands before the page hydrates opens nothing; try again until the panel opens.
    for (let attempt = 0; ; attempt += 1) {
      await browser("click", '[aria-label="Channel details and settings"]');
      const opened = await waitFor(`${panel} !== null`, 5_000).then(
        () => true,
        () => false,
      );
      if (opened) return;
      if (attempt === 5) throw new Error("the channel settings panel never opened");
    }
  }
  /** No finite animation or transition is running (the panel has slid in, a menu has faded out), so
   * a screenshot shows the page at rest. An endless one, such as a spinner, never settles. */
  const settled = `document.getAnimations().every((animation) => animation.playState !== "running" || animation.effect?.getComputedTiming().iterations === Infinity)`;
  /** The right edge of the roster's badge reading `role`. */
  const badgeRight = (role: string) =>
    `Math.round([...${panel}.querySelectorAll("li *")].filter((element) => element.textContent.trim() === ${JSON.stringify(role)}).at(-1)?.getBoundingClientRect().right ?? -1)`;

  const membership = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id, role: "owner" },
    include: { workspace: { select: { slug: true } } },
  });
  const workspacePath = `/en/w/${membership.workspace.slug}`;
  const workspaceId = membership.workspaceId;
  const attached = await db.workspaceComputer.findFirstOrThrow({
    where: { workspaceId, computer: { ownerId: DEV_BROWSER_USER.id } },
  });
  const channel = await db.conversation.create({
    data: { workspaceId, channelName: `e2e-members-${process.pid}`, description: "" },
  });
  const agent = (name: string) =>
    db.agent.create({
      data: {
        workspaceId,
        name: `e2e-members-${name}-${process.pid}`,
        displayName: `Members ${name} ${process.pid}`,
        ownerId: DEV_BROWSER_USER.id,
        computerId: attached.computerId,
        runtimeConfig: {
          runtime: "pi",
          provider: { kind: "default" },
          model: "",
          modelProvider: "",
          reasoning: "",
        },
      },
    });
  const [inside, outside] = await Promise.all([agent("inside"), agent("outside")]);
  const agentIds = [inside.id, outside.id];
  try {
    await db.conversationMember.createMany({
      data: [
        {
          conversationId: channel.id,
          workspaceId,
          userId: DEV_BROWSER_USER.id,
          channelRole: "admin",
        },
        { conversationId: channel.id, workspaceId, agentId: inside.id },
      ],
    });
    await mkdir(artifacts, { recursive: true });

    await browser("set", "viewport", "1440", "900");
    await openChannel(`${workspacePath}/channel/${channel.id}`);

    // The Members summary opens the page in place of the settings.
    await clickText(`[role="dialog"] button`, "1 human · 1 agent");
    await waitFor(`${onRoster} && !${panelHas("Preferences")}`);
    await waitFor(panelHas(inside.displayName));
    await browser("screenshot", join(artifacts, "members.png"));

    // The search narrows the list.
    await browser("fill", 'input[placeholder="Search members…"]', "nobody-matches-this");
    await waitFor(`!${panelHas(inside.displayName)}`);
    await browser("fill", 'input[placeholder="Search members…"]', inside.displayName);
    await waitFor(panelHas(inside.displayName));

    // Add member opens the add view in the same page.
    await clickText(`[role="dialog"] button`, "Add member");
    await waitFor(panelHas("Add selected (0)"));
    await browser("fill", 'input[placeholder="Name"]', outside.displayName);
    // The candidate's label also holds its avatar initial and description.
    const candidate = `[...document.querySelectorAll('[role="dialog"] label')].find((label) => label.textContent.includes(${JSON.stringify(outside.displayName)}))`;
    await waitFor(`${candidate} !== undefined`);
    // Each candidate row is valid markup: its avatar is not inside a paragraph.
    expect(await browser("eval", `${panel}.querySelectorAll("p div").length`)).toContain("0");
    await browser("eval", `${candidate}.querySelector("input").click()`);
    await waitFor(panelHas("Add selected (1)"));
    await browser("screenshot", join(artifacts, "add.png"));
    await clickText(`[role="dialog"] button`, "Add selected (1)");
    await waitFor(`${onRoster} && ${panelHas(outside.displayName)}`);
    expect(
      await db.conversationMember.findFirst({
        where: { conversationId: channel.id, agentId: outside.id, leftAt: null },
      }),
    ).not.toBeNull();

    // A channel admin makes the new member a channel admin.
    await browser(
      "eval",
      `document.querySelector(${JSON.stringify(`[aria-label="Make ${outside.displayName} a channel admin"]`)}).click()`,
    );
    await waitFor(
      `document.querySelector(${JSON.stringify(`[aria-label="Remove channel admin from ${outside.displayName}"]`)}) !== null`,
    );
    expect(
      (
        await db.conversationMember.findFirstOrThrow({
          where: { conversationId: channel.id, agentId: outside.id },
        })
      ).channelRole,
    ).toBe("admin");

    // Every role badge ends on the same line, whatever actions its row offers (the dev user's own
    // row has no role change), and a plain member's row shows no badge.
    await browser("fill", 'input[placeholder="Search members…"]', "");
    await waitFor(panelHas(inside.displayName));
    const [ownerRight, adminRight] = await evaluate<number[]>(
      `[${badgeRight("Owner")}, ${badgeRight("Channel admin")}]`,
    );
    expect(ownerRight).toBeGreaterThan(0);
    expect(adminRight).toBe(ownerRight);
    expect(await evaluate<number>(badgeRight("Member"))).toBe(-1);
    await browser("screenshot", join(artifacts, "roles.png"));

    // Removing asks first.
    await browser(
      "eval",
      `document.querySelector(${JSON.stringify(`[aria-label="Remove ${outside.displayName}"]`)}).click()`,
    );
    await waitFor(`document.body.textContent.includes("Remove member")`);
    await browser("screenshot", join(artifacts, "remove.png"));
    expect(
      (
        await db.conversationMember.findFirstOrThrow({
          where: { conversationId: channel.id, agentId: outside.id },
        })
      ).leftAt,
    ).toBeNull();
    await clickText('[role="dialog"] button', "Remove");
    await waitFor(`!${panelHas(outside.displayName)}`);
    expect(
      (
        await db.conversationMember.findFirstOrThrow({
          where: { conversationId: channel.id, agentId: outside.id },
        })
      ).leftAt,
    ).not.toBeNull();

    // An Agent's row opens its profile inside the panel; Back returns to the members with the
    // search kept and focus on the row that opened it.
    // The channel header's faces carry the same label, so the row is looked up in the panel.
    const openProfile = `[aria-label="Open ${inside.displayName}'s profile"]`;
    const search = `${panel}?.querySelector('input[placeholder="Search members…"]')`;
    await browser("fill", 'input[placeholder="Search members…"]', inside.displayName);
    await browser("eval", `${panel}.querySelector(${JSON.stringify(openProfile)}).click()`);
    await waitFor(`${panel}?.querySelector('[role="tablist"]') != null && !${onRoster}`);
    await waitFor(panelHas(inside.displayName));
    await browser("screenshot", join(artifacts, "profile.png"));
    await browser("eval", `document.querySelector('[aria-label="Back to members"]').click()`);
    await waitFor(
      `${search}?.value === ${JSON.stringify(inside.displayName)} && document.activeElement?.matches(${JSON.stringify(openProfile)})`,
    );

    // Back returns to the settings.
    await browser("eval", `document.querySelector('[aria-label="Back"]').click()`);
    await waitFor(panelHas("Preferences"));

    // Close from the profile closes the whole panel; the next opening starts on the settings.
    await clickText(`[role="dialog"] button`, "1 human · 1 agent");
    await waitFor(`${search}?.value === ""`);
    await browser("eval", `${panel}.querySelector(${JSON.stringify(openProfile)}).click()`);
    await waitFor(`${panel}?.querySelector('[role="tablist"]') != null`);
    await browser("eval", `${panel}.querySelector('[aria-label="Close"]').click()`);
    await waitFor(`${panel} === null`);
    await browser("click", '[aria-label="Channel details and settings"]');
    await waitFor(`${panelHas("Preferences")} && !${onRoster}`);

    // A phone has no hover to reveal the actions: each row keeps them behind one menu button, so
    // the name keeps its width, and the menu makes the member a channel admin.
    await browser("set", "viewport", "390", "844");
    await openChannel(`${workspacePath}/channel/${channel.id}`);
    await clickText(`[role="dialog"] button`, "1 human · 1 agent");
    const actions = `[aria-label="Actions for ${inside.displayName}"]`;
    await waitFor(`${onRoster} && document.querySelector(${JSON.stringify(actions)}) !== null`);
    expect(
      await evaluate<{ inlineActions: number; nameClipped: boolean }>(`(() => {
        const row = document.querySelector(${JSON.stringify(actions)}).closest("li");
        const name = [...row.querySelectorAll("span")].find(
          (span) => span.children.length === 0 && span.textContent === ${JSON.stringify(inside.displayName)},
        );
        return {
          inlineActions: row.querySelectorAll('[aria-label^="Make "], [aria-label^="Remove "]').length,
          nameClipped: name.scrollWidth > name.clientWidth,
        };
      })()`),
    ).toEqual({ inlineActions: 0, nameClipped: false });
    await waitFor(settled);
    await browser("screenshot", join(artifacts, "phone-members.png"));
    await browser("click", actions);
    await waitFor(`document.querySelector('[role="menuitem"]') !== null`);
    await browser("find", "role", "menuitem", "click", "--name", "Make admin");
    await waitFor(
      `${badgeRight("Channel admin")} > 0 && document.querySelector('[role="menu"]') === null`,
    );
    expect(
      (
        await db.conversationMember.findFirstOrThrow({
          where: { conversationId: channel.id, agentId: inside.id },
        })
      ).channelRole,
    ).toBe("admin");
    // The menu button's room keeps every badge on one line on a phone too.
    const [phoneOwnerRight, phoneAdminRight] = await evaluate<number[]>(
      `[${badgeRight("Owner")}, ${badgeRight("Channel admin")}]`,
    );
    expect(phoneOwnerRight).toBeGreaterThan(0);
    expect(phoneAdminRight).toBe(phoneOwnerRight);
    await waitFor(settled);
    await browser("screenshot", join(artifacts, "phone-admin.png"));
  } finally {
    await db.conversation.deleteMany({ where: { id: channel.id } }).catch(() => {});
    await db.agent.deleteMany({ where: { id: { in: agentIds } } }).catch(() => {});
    await browser("close").catch(() => undefined);
    await db.$disconnect();
  }
}, 300_000);
