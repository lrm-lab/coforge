import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { AGENT_ACTIVITY_DETAIL_KIND } from "@lrm/coforge-sdk/internal";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { browserSession, localBrowserE2e } from "./helpers/browser-e2e";

/**
 * The Agent panel's Activity log names each day it runs into (task #718): Today, Yesterday, and an
 * older day by its date, each above that day's first row, so an old run of entries never reads as
 * happening now. Needs a local built Web with skip-auth, PostgreSQL and agent-browser. No model
 * runs. The suite removes its own Workspace and Computer. Screenshots are written under
 * .amp/e2e/agent-activity-days/.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
const artifacts = join(import.meta.dir, "../../../.amp/e2e/agent-activity-days");
const { browser, evaluate } = browserSession(browserPath, `agent-activity-days-${process.pid}`);
const DAY = 24 * 60 * 60 * 1000;
let workspaceId: string;
let workspaceSlug: string;
let computerId: string;
let agentId: string;

beforeAll(async () => {
  await mkdir(artifacts, { recursive: true });
  await db.user.upsert({
    where: { id: DEV_BROWSER_USER.id },
    update: {},
    create: {
      id: DEV_BROWSER_USER.id,
      username: DEV_BROWSER_USER.username,
      displayName: "Activity reviewer",
      welcomedAt: new Date(),
    },
  });
  const workspace = await db.workspace.create({
    data: {
      name: "Activity days",
      slug: `agent-activity-days-${process.pid}`,
      members: { create: [{ userId: DEV_BROWSER_USER.id, role: "owner" }] },
    },
  });
  workspaceId = workspace.id;
  workspaceSlug = workspace.slug;
  const computer = await db.computer.create({
    data: { ownerId: DEV_BROWSER_USER.id, machineId: `agent-activity-days-${process.pid}` },
  });
  computerId = computer.id;
  const agent = await db.agent.create({
    data: {
      workspaceId,
      ownerId: DEV_BROWSER_USER.id,
      computerId,
      name: "activity-days",
      visibility: "private",
      displayName: "Activity days",
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
  // Ten days back, yesterday, and the last few seconds: the stalled-runtime run Frank misread
  // sits on an older day.
  const now = Date.now();
  const rows = [
    ...[0, 1, 2].map((i) => ({
      at: now - 10 * DAY + i * 60_000,
      detail: "Restarting stalled Codex runtime",
    })),
    ...[0, 1].map((i) => ({
      at: now - DAY + i * 60_000,
      detail: `bun run test --filter segment-${i}`,
    })),
    ...[3, 2, 1].map((i) => ({ at: now - i * 1000, detail: `git status --short # ${i}` })),
  ];
  await db.agentActivity.createMany({
    data: rows.map((row, index) => ({
      workspaceId,
      agentId,
      computerId,
      launchId: "e2e-launch",
      clientSeq: index + 1,
      detailKind: AGENT_ACTIVITY_DETAIL_KIND.RUNNING_COMMAND,
      level: "info",
      detail: row.detail,
      occurredAt: new Date(row.at),
    })),
  });
});

afterAll(async () => {
  await browser("close").catch(() => undefined);
  if (workspaceId) await db.workspace.delete({ where: { id: workspaceId } });
  if (computerId) await db.computer.delete({ where: { id: computerId } });
  await db.$disconnect();
});

for (const width of [1440, 390])
  test(`${width}px: each day in the Activity log is named above its first row`, async () => {
    await browser("set", "viewport", String(width), "844");
    await browser(
      "open",
      `${origin}/en/w/${workspaceSlug}/members?profile=agent:${agentId}&agentTab=activity`,
    );
    await browser(
      "wait",
      "--fn",
      `document.querySelectorAll('ol[aria-label="Activity timeline"] h3').length === 3`,
    );
    await browser("eval", "document.fonts.ready");
    // The log top to bottom: each heading, then the rows of its day.
    const log = await evaluate<string[]>(
      `[...document.querySelector('ol[aria-label="Activity timeline"]').children].map((li) => li.querySelector("h3") ? "# " + li.textContent.trim() : (li.textContent.match(/Restarting stalled|segment-\\d|# \\d/) ?? ["?"])[0])`,
    );
    const older = log[0]!;
    expect(older).toMatch(/^# \w+, \w+ \d+$/);
    expect(log).toEqual([
      older,
      "Restarting stalled",
      "Restarting stalled",
      "Restarting stalled",
      "# Yesterday",
      "segment-0",
      "segment-1",
      "# Today",
      "# 3",
      "# 2",
      "# 1",
    ]);
    for (const theme of ["light", "dark"] as const) {
      await evaluate(
        `document.documentElement.classList.${theme === "dark" ? "add" : "remove"}("dark-mode") ?? true`,
      );
      await browser("wait", "300");
      await browser("screenshot", join(artifacts, `${width}-${theme}.png`));
    }
    await evaluate(`document.documentElement.classList.remove("dark-mode") ?? true`);
  });
