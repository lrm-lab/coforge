import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { browserSession, desktopPointerInitScript, localBrowserE2e } from "./helpers/browser-e2e";
import { sameOriginProxy } from "./helpers/same-origin-proxy";

/**
 * The settings panel's "Coordinator Agent" picker lists the channel's member Agents from the
 * page payload's `mentionables`, a mount-time copy that only a full reload refreshes (task
 * #736): after a member is added or removed the dropdown keeps the old list until the page is
 * reopened. Every other member surface already reads the live directory `member.changed.v1`
 * refreshes — the fix hands the panel that same directory. This test adds and removes an Agent
 * member through the members page and reads the picker without reloading the page.
 *
 * Needs a local built Web with skip-auth, PostgreSQL, local Centrifugo and agent-browser. No
 * model runs. The suite removes its own Workspace, people, Computer and channel. Screenshots
 * live in `.amp/e2e/channel-coordinator-members/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const centrifugoOrigin = Bun.env.COFORGE_E2E_CENTRIFUGO_URL;
if (!centrifugoOrigin || !["localhost", "127.0.0.1"].includes(new URL(centrifugoOrigin).hostname))
  throw new Error("COFORGE_E2E_CENTRIFUGO_URL must target local Centrifugo");
const proxy = sameOriginProxy(origin, centrifugoOrigin);
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
const artifacts = join(import.meta.dir, "../../../.amp/e2e/channel-coordinator-members");
const { browser, evaluate, waitFor, clickText } = browserSession(
  browserPath,
  `channel-coordinator-members-${process.pid}`,
);

let workspaceId: string;
let workspaceSlug: string;
let channelId: string;
let computerId: string;
let ownerUserId: string;
const agents = {
  member: { id: "", displayName: "" },
  added: { id: "", displayName: "" },
};

const panel = `document.querySelector('[role="dialog"][aria-label="Channel details and settings"]')`;
const picker = `button[aria-label^="Coordinator Agent:"]`;
const pickerOptions = `[...document.querySelectorAll('[role^="menuitem"]')].map((item) => item.textContent ?? "")`;
const panelHas = (text: string) => `${panel}?.textContent.includes(${JSON.stringify(text)})`;
/** The settings' Members row whatever the counts currently are. */
const membersRow = `[...document.querySelectorAll('[role="dialog"] button')].find((button) => button.textContent.includes("human") && button.textContent.includes("agent"))`;

const pickerTrigger = `document.querySelector('${picker}')`;

/** The coordinator picker's option labels right now, opening it first. */
async function coordinatorOptions(): Promise<string[]> {
  await browser("eval", `${pickerTrigger}.click()`);
  await waitFor(`document.querySelectorAll('[role^="menuitem"]').length > 0`, 15_000);
  const options = await evaluate<string[]>(pickerOptions);
  await browser("press", "Escape");
  await waitFor(`document.querySelectorAll('[role^="menuitem"]').length === 0`, 15_000);
  return options;
}

const hasAgent = (options: string[], displayName: string) =>
  options.some((option) => option.includes(displayName));

/** Opens the picker until `predicate` holds on its options or the attempts run out. */
async function waitForOptions(predicate: (options: string[]) => boolean, what: string) {
  for (let attempt = 0; attempt < 15; attempt++) {
    const options = await coordinatorOptions();
    if (predicate(options)) return;
    await Bun.sleep(400);
  }
  throw new Error(`coordinator picker never showed ${what}`);
}

beforeAll(async () => {
  await mkdir(artifacts, { recursive: true });
  await db.user.upsert({
    where: { id: DEV_BROWSER_USER.id },
    update: {},
    create: {
      id: DEV_BROWSER_USER.id,
      username: DEV_BROWSER_USER.username,
      displayName: "Coordinator reviewer",
      welcomedAt: new Date(),
    },
  });
  const owner = await db.user.create({
    data: {
      username: `coordinator-owner-${process.pid}`,
      displayName: "Coordinator owner",
      welcomedAt: new Date(),
    },
  });
  ownerUserId = owner.id;
  const workspace = await db.workspace.create({
    data: {
      name: "Channel coordinator members",
      slug: `channel-coordinator-${process.pid}`,
      members: {
        create: [
          { userId: DEV_BROWSER_USER.id, role: "member" },
          { userId: owner.id, role: "owner" },
        ],
      },
    },
  });
  workspaceId = workspace.id;
  workspaceSlug = workspace.slug;
  const computer = await db.computer.create({
    data: {
      ownerId: owner.id,
      machineId: `coordinator-${process.pid}`,
      name: `coordinator-${process.pid}.local`,
      displayName: "E2E Studio",
      kind: "local",
      workspaces: { create: { workspaceId } },
    },
  });
  computerId = computer.id;
  const runtimeConfig = {
    runtime: "pi",
    provider: { kind: "default" },
    model: "",
    modelProvider: "",
    reasoning: "",
  };
  for (const key of ["member", "added"] as const) {
    const agent = await db.agent.create({
      data: {
        workspaceId,
        ownerId: owner.id,
        computerId: computer.id,
        name: `coordinator-${key}-${process.pid}`,
        displayName: `Coordination ${key === "member" ? "Member" : "Added"} Agent ${process.pid}`,
        visibility: "public",
        runtimeConfig,
      },
    });
    agents[key] = { id: agent.id, displayName: agent.displayName ?? "" };
  }
  const channel = await db.conversation.create({
    data: { workspaceId, channelName: `coordinator-${process.pid}`, description: "" },
  });
  channelId = channel.id;
  await db.conversationMember.createMany({
    data: [
      {
        conversationId: channel.id,
        workspaceId,
        userId: DEV_BROWSER_USER.id,
        channelRole: "admin",
      },
      { conversationId: channel.id, workspaceId, agentId: agents.member.id },
    ],
  });
});

afterAll(async () => {
  await browser("close");
  proxy.stop();
  if (workspaceId) await db.workspace.delete({ where: { id: workspaceId } });
  if (computerId) await db.computer.delete({ where: { id: computerId } });
  if (ownerUserId) await db.user.delete({ where: { id: ownerUserId } });
  await db.$disconnect();
});

test("the coordinator picker follows member changes without a page reload", async () => {
  const pointerInit = await desktopPointerInitScript(artifacts);
  await browser("--init-script", pointerInit, "set", "viewport", "1440", "900");
  await browser("open", `${proxy.origin}/en/w/${workspaceSlug}/channel/${channelId}`);
  await waitFor(
    `document.querySelector('[aria-label="Channel details and settings"]') !== null`,
    60_000,
  );
  await browser("click", '[aria-label="Channel details and settings"]');
  await waitFor(`${panel} !== null`, 15_000);
  await waitFor(`${panel}?.querySelector('${picker}') != null`, 15_000);

  // The member Agent is offered; the not-yet-member one is not.
  await waitForOptions(
    (options) =>
      hasAgent(options, agents.member.displayName) && !hasAgent(options, agents.added.displayName),
    "the member Agent and not the other",
  );

  // Members → Add Member → pick the second Agent → confirm.
  await waitFor(`${membersRow} !== undefined`, 15_000);
  await browser("eval", `${membersRow}.click()`);
  await clickText('[role="dialog"] button', "Add member");
  await waitFor(panelHas("Add selected (0)"), 15_000);
  await browser("fill", 'input[placeholder="Name"]', agents.added.displayName);
  const candidate = `[...document.querySelectorAll('[role="dialog"] label')].find((label) => label.textContent.includes(${JSON.stringify(agents.added.displayName)}))`;
  await waitFor(`${candidate} !== undefined`, 15_000);
  await browser("eval", `${candidate}.querySelector("input").click()`);
  await waitFor(panelHas("Add selected (1)"), 15_000);
  await clickText('[role="dialog"] button', "Add selected (1)");
  await waitFor(panelHas(agents.added.displayName), 15_000);

  // Back to the settings: the picker now offers the added Agent, still without a reload.
  // The members view comes back after the add or remove settles; its Back is there once it has.
  await waitFor(`document.querySelector('[aria-label="Back"]') != null`, 15_000);
  await browser("eval", `document.querySelector('[aria-label="Back"]').click()`);
  await waitFor(`${panel}?.querySelector('${picker}') != null`, 15_000);
  await waitForOptions((options) => hasAgent(options, agents.added.displayName), "the added Agent");
  await browser("screenshot", join(artifacts, "coordinator-added.png"));

  // Remove it again through the members page: the picker drops it just the same.
  await browser("eval", `${membersRow}.click()`);
  await waitFor(
    `document.querySelector('[aria-label="Remove ${agents.added.displayName}"]') !== null`,
    15_000,
  );
  await browser(
    "eval",
    `document.querySelector('[aria-label="Remove ${agents.added.displayName}"]').click()`,
  );
  await waitFor(`document.body.textContent.includes("Remove member")`, 15_000);
  await clickText('[role="dialog"] button', "Remove member");
  await waitFor(`!${panelHas(agents.added.displayName)}`, 15_000);
  // The members view comes back after the add or remove settles; its Back is there once it has.
  await waitFor(`document.querySelector('[aria-label="Back"]') != null`, 15_000);
  await browser("eval", `document.querySelector('[aria-label="Back"]').click()`);
  await waitFor(`${panel}?.querySelector('${picker}') != null`, 15_000);
  await waitForOptions(
    (options) =>
      !hasAgent(options, agents.added.displayName) && hasAgent(options, agents.member.displayName),
    "the removed Agent gone and the member Agent kept",
  );
  await browser("screenshot", join(artifacts, "coordinator-removed.png"));

  // The membership row landed soft-left, as the remove flow promises.
  expect(
    (
      await db.conversationMember.findFirstOrThrow({
        where: { conversationId: channelId, agentId: agents.added.id },
      })
    ).leftAt,
  ).not.toBeNull();
}, 180_000);
