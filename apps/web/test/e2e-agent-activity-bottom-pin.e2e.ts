import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { AGENT_ACTIVITY_DETAIL_KIND, encodeAgentActivity } from "@lrm/coforge-sdk/internal";
import { agentActivityChannelFor } from "#src/features/agents/agent-activity";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { browserSession, localBrowserE2e } from "./helpers/browser-e2e";
import { sameOriginProxy } from "./helpers/same-origin-proxy";

/**
 * The Agent panel's Activity tab opens on its newest row and stays there while rows settle to
 * their real heights; a reader who scrolled up keeps their place when live rows arrive, and is
 * followed again once back at the bottom (task #201). Rows are long commands that wrap on a phone,
 * so their rendered height differs from the content-visibility estimate. Live rows are published
 * straight to the private Agent's Activity channel. Needs a local built Web with skip-auth,
 * PostgreSQL, local Centrifugo and agent-browser. No model runs. The suite removes its own Workspace and Computer. Screenshots and
 * measurements live in .amp/e2e/agent-activity-bottom-pin/.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const centrifugoOrigin = Bun.env.COFORGE_E2E_CENTRIFUGO_URL;
if (!centrifugoOrigin || !["localhost", "127.0.0.1"].includes(new URL(centrifugoOrigin).hostname))
  throw new Error("COFORGE_E2E_CENTRIFUGO_URL must target local Centrifugo");
// The page reaches Centrifugo on its own origin, as behind the production proxy.
const proxy = sameOriginProxy(origin, centrifugoOrigin);
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
const artifacts = join(import.meta.dir, "../../../.amp/e2e/agent-activity-bottom-pin");
const { browser, evaluate } = browserSession(browserPath, `activity-bottom-pin-${process.pid}`);
const ROWS = 120;
let workspaceId: string;
let workspaceSlug: string;
let computerId: string;
let agentId: string;

const scroller = `document.querySelector('ol[aria-label="Activity timeline"]')?.parentElement`;
const distance = `(() => { const s=${scroller}; return s ? Math.round(s.scrollHeight - s.scrollTop - s.clientHeight) : null; })()`;
const centrifugo = createCentrifugoServerApi();
let clientSeq = 0;

/** `distance` once it has held still across a few frames: rows settle past their estimates. */
async function settledDistance() {
  // `eval` awaits the promise and prints its value as JSON.
  const settled = await browser(
    "eval",
    `new Promise((resolve) => {
    let last = null, still = 0;
    const tick = () => {
      const now = ${distance};
      still = now === last ? still + 1 : 0;
      last = now;
      if (still >= 10) resolve(now); else requestAnimationFrame(tick);
    };
    tick();
  })`,
  );
  return Number(JSON.parse(settled));
}

/** Publishes one live Activity row, as the daemon's relay would, and waits for it to render. */
async function publishRow(label: string) {
  clientSeq += 1;
  await centrifugo.publish(
    agentActivityChannelFor(workspaceId, agentId, "private"),
    encodeAgentActivity({
      protocolMajor: 1,
      requestId: crypto.randomUUID(),
      workspaceId,
      agentId,
      detailKind: AGENT_ACTIVITY_DETAIL_KIND.RUNNING_COMMAND,
      level: "info",
      detail: `echo ${label} && bun run test --filter some/long/path/live-segment --reporter verbose`,
      observedAtMs: Date.now(),
      launchId: "e2e-launch",
      clientSeq,
    }),
  );
  await browser(
    "wait",
    "--fn",
    `document.body.innerText.includes(${JSON.stringify(`echo ${label}`)})`,
  );
}

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
      name: "Activity bottom pin",
      slug: `activity-bottom-pin-${process.pid}`,
      members: { create: [{ userId: DEV_BROWSER_USER.id, role: "owner" }] },
    },
  });
  workspaceId = workspace.id;
  workspaceSlug = workspace.slug;
  const computer = await db.computer.create({
    data: {
      ownerId: DEV_BROWSER_USER.id,
      machineId: `activity-bottom-pin-${process.pid}`,
    },
  });
  computerId = computer.id;
  const agent = await db.agent.create({
    data: {
      workspaceId,
      ownerId: DEV_BROWSER_USER.id,
      computerId,
      name: "activity-pin",
      // Its Activity is relayed on its own channel, which the test publishes to directly.
      visibility: "private",
      displayName: "Activity pin",
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
  clientSeq = ROWS;
  const start = Date.now() - ROWS * 1000;
  await db.agentActivity.createMany({
    data: Array.from({ length: ROWS }, (_, index) => ({
      workspaceId,
      agentId,
      computerId,
      launchId: "e2e-launch",
      clientSeq: index + 1,
      detailKind: AGENT_ACTIVITY_DETAIL_KIND.RUNNING_COMMAND,
      level: "info",
      // Long enough to wrap to several lines on a phone, short of the 200-character fold.
      detail: `cd /workspace/project-${index} && bun run test --filter some/long/path/segment-${index} --reporter verbose`,
      occurredAt: new Date(start + index * 1000),
    })),
  });
});

afterAll(async () => {
  await browser("close");
  proxy.stop();
  if (workspaceId) await db.workspace.delete({ where: { id: workspaceId } });
  if (computerId) await db.computer.delete({ where: { id: computerId } });
  await db.$disconnect();
});

for (const width of [1440, 390])
  test(`${width}px: Activity opens on its newest row and keeps a reader's place`, async () => {
    await browser("set", "viewport", String(width), "844");
    await browser(
      "open",
      `${proxy.origin}/en/w/${workspaceSlug}/members?profile=agent:${agentId}&agentTab=activity`,
    );
    await browser("wait", "--fn", `${scroller} != null`);
    await browser("eval", "document.fonts.ready");
    const opened = await settledDistance();
    await browser("screenshot", join(artifacts, `${width}-opened.png`));

    // Scrolled up, live rows arriving leave the reader where they are.
    await browser(
      "eval",
      `(() => { const s=${scroller}; s.dispatchEvent(new WheelEvent("wheel")); s.scrollTop -= 600; })()`,
    );
    const scrolledUp = await settledDistance();
    const topBefore = await evaluate<number>(`Math.round(${scroller}.scrollTop)`);
    await publishRow(`up-${width}-1`);
    await publishRow(`up-${width}-2`);
    const whileReading = await settledDistance();
    const topAfter = await evaluate<number>(`Math.round(${scroller}.scrollTop)`);

    // Back at the bottom, new rows are followed again.
    await browser(
      "eval",
      `(() => { const s=${scroller}; s.dispatchEvent(new WheelEvent("wheel")); s.scrollTop = s.scrollHeight; })()`,
    );
    await settledDistance();
    await publishRow(`down-${width}-1`);
    await publishRow(`down-${width}-2`);
    const followed = await settledDistance();
    await browser("screenshot", join(artifacts, `${width}-followed.png`));
    await Bun.write(
      join(artifacts, `${width}.json`),
      JSON.stringify({ opened, scrolledUp, whileReading, topBefore, topAfter, followed }, null, 2),
    );
    expect(opened).toBeLessThanOrEqual(1);
    expect(scrolledUp).toBeGreaterThan(300);
    expect(Math.abs(topAfter - topBefore)).toBeLessThanOrEqual(1);
    expect(whileReading).toBeGreaterThan(scrolledUp);
    expect(followed).toBeLessThanOrEqual(1);
  }, 120_000);
