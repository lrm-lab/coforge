import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { browserSession, localBrowserE2e } from "./helpers/browser-e2e";

/**
 * A Computer's Agents on a 390px phone (task #143): each row keeps its name and runtime, and its
 * @handle truncates, so a generated handle longer than the screen (a Workspace assistant's
 * `assistant-<uuid>`) neither pushes the page sideways nor squeezes the row's name to nothing. The Select and Create Agent buttons move under the heading when they do not fit beside
 * it. Run with `mise run test:e2e:web e2e-computer-agent-roster-phone`. Screenshots live in
 * .amp/e2e/computer-agent-roster-phone/. The suite removes its own Computer and Agents.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
const artifacts = join(import.meta.dir, "../../../.amp/e2e/computer-agent-roster-phone");
const { browser, evaluate } = browserSession(browserPath, `computer-roster-${process.pid}`);
let slug = "";
let computerId = "";
const agentIds: string[] = [];

const AGENTS = [
  { name: `assistant-${crypto.randomUUID()}`, displayName: "通用助手", runtime: "pi" },
  { name: `roster-coder-${process.pid}`, displayName: "coforge-ui", runtime: "claude-code" },
  { name: `roster-backend-${process.pid}`, displayName: "coforge-backend", runtime: "codex" },
];

beforeAll(async () => {
  await mkdir(artifacts, { recursive: true });
  const membership = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id, role: "owner" },
    include: { workspace: true },
  });
  slug = membership.workspace.slug;
  const computer = await db.computer.create({
    data: {
      ownerId: DEV_BROWSER_USER.id,
      machineId: `roster-phone-${process.pid}`,
      name: `roster-phone-${process.pid}`,
      computerVersion: "1.0.53",
      platform: "darwin",
    },
  });
  computerId = computer.id;
  await db.workspaceComputer.create({
    data: { workspaceId: membership.workspaceId, computerId },
  });
  for (const agent of AGENTS) {
    const created = await db.agent.create({
      data: {
        workspaceId: membership.workspaceId,
        ownerId: DEV_BROWSER_USER.id,
        computerId,
        name: agent.name,
        displayName: agent.displayName,
        runtimeConfig: {
          runtime: agent.runtime,
          provider: { kind: "default" },
          model: agent.runtime === "pi" ? "" : "claude-opus-5-5-with-a-long-model-name",
          modelProvider: "",
          reasoning: "",
        },
      },
    });
    agentIds.push(created.id);
  }
});

afterAll(async () => {
  await browser("close");
  if (agentIds.length) await db.agent.deleteMany({ where: { id: { in: agentIds } } });
  if (computerId) {
    await db.workspaceComputer.deleteMany({ where: { computerId } });
    await db.computer.delete({ where: { id: computerId } });
  }
  await db.$disconnect();
});

test("on a phone every Agent row keeps its name and runtime, and nothing overflows", async () => {
  await browser("set", "viewport", "390", "844");
  await browser("open", `${origin}/en/w/${slug}/computer/${computerId}`);
  await browser("wait", "#computer-agents-on-computer");
  await browser("wait", "--fn", `document.body.innerText.includes("通用助手")`);
  await browser(
    "eval",
    `document.getElementById("computer-agents-on-computer").scrollIntoView({ block: "start" })`,
  );
  await browser("screenshot", join(artifacts, "390.png"));

  const layout = await evaluate<{
    scrollWidth: number;
    rows: { text: string; nameWidth: number; handleRight: number; right: number }[];
    heading: { bottom: number };
    buttonsTop: number;
  }>(`(() => {
    const section = document.querySelector('section[aria-labelledby="computer-agents-on-computer"]');
    const rows = [...section.querySelectorAll("ul > li")].map((li) => {
      const name = li.querySelector(".font-medium");
      const handle = [...li.querySelectorAll("span")].find((s) => s.textContent.startsWith("@"));
      return {
        text: li.innerText.replace(/\\s+/g, " ").trim(),
        nameWidth: Math.round(name.getBoundingClientRect().width),
        handleRight: Math.round(handle.getBoundingClientRect().right),
        right: Math.round(li.getBoundingClientRect().right),
      };
    });
    const heading = document.getElementById("computer-agents-on-computer").getBoundingClientRect();
    const create = [...section.querySelectorAll("button")].find((b) => b.innerText.includes("Create Agent"));
    return {
      scrollWidth: document.documentElement.scrollWidth,
      rows,
      heading: { bottom: Math.round(heading.bottom) },
      buttonsTop: Math.round(create.getBoundingClientRect().top),
    };
  })()`);
  await Bun.write(join(artifacts, "390.json"), JSON.stringify(layout, null, 2));

  expect(layout.scrollWidth).toBeLessThanOrEqual(390);
  expect(layout.rows).toHaveLength(AGENTS.length);
  for (const row of layout.rows) {
    expect(row.nameWidth).toBeGreaterThan(0);
    expect(row.right).toBeLessThanOrEqual(390);
    expect(row.text).toContain("@");
    expect(row.handleRight).toBeLessThanOrEqual(row.right);
  }
  const assistant = layout.rows.find((row) => row.text.includes("通用助手"));
  expect(assistant?.text).toContain("Pi");
  // The buttons do not fit beside the heading at this width, so they wrap under it.
  expect(layout.buttonsTop).toBeGreaterThanOrEqual(layout.heading.bottom);
}, 120_000);

test("on a desktop the buttons stay beside the heading; dark mode reads the same", async () => {
  await browser("set", "viewport", "1440", "900");
  await browser("open", `${origin}/en/w/${slug}/computer/${computerId}`);
  await browser("wait", "--fn", `document.body.innerText.includes("通用助手")`);
  await browser(
    "eval",
    `document.getElementById("computer-agents-on-computer").scrollIntoView({ block: "start" })`,
  );
  const sameLine = await evaluate<boolean>(`(() => {
    const heading = document.getElementById("computer-agents-on-computer").getBoundingClientRect();
    const create = [...document.querySelectorAll("button")].find((b) => b.innerText.includes("Create Agent")).getBoundingClientRect();
    return create.top < heading.bottom && create.bottom > heading.top;
  })()`);
  expect(sameLine).toBe(true);
  await browser("screenshot", join(artifacts, "1440.png"));
  await browser("set", "viewport", "390", "844");
  await browser(
    "eval",
    `document.documentElement.classList.replace("light-mode", "dark-mode") ||
       document.documentElement.classList.add("dark-mode");
     document.getElementById("computer-agents-on-computer").scrollIntoView({ block: "start" })`,
  );
  // Let the buttons' colour transitions finish.
  await browser("wait", "500");
  await browser("screenshot", join(artifacts, "390-dark.png"));
}, 120_000);
