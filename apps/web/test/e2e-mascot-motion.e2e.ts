import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";
import { agentDisplay } from "#src/features/agents/agent-activity-presentation";
import { agentStatusChannel } from "#src/features/agents/agent-status-channel";
import { MASCOT_IDS, type MascotId } from "#src/features/agents/mascot-contract";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { browserSession, localBrowserE2e } from "./helpers/browser-e2e";
import { sameOriginProxy } from "./helpers/same-origin-proxy";

/**
 * The five newest mascots (magenta, cyan, teal, coral, lime) really animate. A screenshot cannot
 * tell a Rive canvas that moves from one that drew its first frame and stopped, and a Rive canvas
 * is no CSS animation, so `getAnimations()` sees nothing. This reads the pixels instead: the
 * mascots draw on 2D canvases (`@rive-app/canvas-lite`), so a page-side sampler hashes
 * `canvas.toDataURL()` every 40 ms and keeps the first image of each distinct frame, and the test
 * judges the frames.
 *   1. Idle: in the mascot picker (outside the three-mascot motion budget, so all twelve move),
 *      each of the five repeatedly changes frames, in episodes of motion two to six seconds apart: the idle loop's float turns every 2 to
 *      2.5 s and its double blinks come every 4.2 to 4.8 s (`assets/mascots/activity.ts`).
 *   2. Hover: with the pointer over a mascot it shows a pose that it shows with the pointer beside
 *      it by more than the eyes alone explain (the eyes follow the pointer, so the control
 *      windows have the pointer just left and just right of the tile, and the largest difference
 *      between those two is the eyes' share).
 *   3. Thinking and working: an Agent's Direct-message header mascot, given `agent:display`
 *      snapshots on the Workspace's status channel as the cloud publishes them, moves in each
 *      state, and working shows frames that neither idle nor thinking showed.
 * Needs a local built Web with skip-auth, PostgreSQL, local Centrifugo and agent-browser, with
 * motion allowed (the run turns `prefers-reduced-motion` off). No model runs. The suite removes
 * its own Workspace, people and Computer. Screenshots, light and dark, and the measured numbers
 * live in .amp/e2e/mascot-motion/.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const centrifugoOrigin = Bun.env.COFORGE_E2E_CENTRIFUGO_URL;
if (!centrifugoOrigin || !["localhost", "127.0.0.1"].includes(new URL(centrifugoOrigin).hostname))
  throw new Error("COFORGE_E2E_CENTRIFUGO_URL must target local Centrifugo");
const proxy = sameOriginProxy(origin, centrifugoOrigin);
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
const artifacts = join(import.meta.dir, "../../../.amp/e2e/mascot-motion");
const { browser, evaluate } = browserSession(browserPath, `mascot-motion-${process.pid}`);
const centrifugo = createCentrifugoServerApi();

/** The five mascots added last (Frank, 2026-10-29), the last five of the contract. */
const NEW_MASCOTS = MASCOT_IDS.slice(-5);
if (NEW_MASCOTS.join() !== "magenta,cyan,teal,coral,lime")
  throw new Error("the contract's last five mascots changed");

let workspaceId: string;
let workspaceSlug: string;
let computerId: string;
type Peer = { mascot: MascotId; name: string; agentId: string; conversationId: string };
const peers: Peer[] = NEW_MASCOTS.map((mascot) => ({
  mascot,
  name: `Motion ${mascot}`,
  agentId: "",
  conversationId: "",
}));

/** The page-side sampler: named windows of canvas frames, read back as numbers. */
const SAMPLER = `
window.__mm = (() => {
  const windows = {};
  let timer = 0;
  const hash = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return h; };
  function tick() {
    const now = performance.now();
    for (const w of Object.values(windows)) {
      if (w.done) continue;
      const canvas = new Function("return " + w.find)();
      if (!canvas || !canvas.width) { w.missing++; continue; }
      const px = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
      const h = hash(canvas.toDataURL());
      let d = 0;
      if (w.prev) for (let i = 0; i < px.length; i += 4)
        if (Math.abs(px[i] - w.prev[i]) + Math.abs(px[i + 1] - w.prev[i + 1]) + Math.abs(px[i + 2] - w.prev[i + 2]) + Math.abs(px[i + 3] - w.prev[i + 3]) > 48) d++;
      w.prev = px;
      w.t.push(Math.round(now - w.start)); w.h.push(h); w.d.push(d);
      if (!w.frames.has(h)) w.frames.set(h, px);
    }
  }
  return {
    start(label, find) {
      windows[label] = { find, start: performance.now(), t: [], h: [], d: [], prev: null, frames: new Map(), missing: 0, done: false };
      if (!timer) timer = setInterval(tick, 40);
    },
    stop(label) { windows[label].done = true; },
    read(label) { const w = windows[label]; return { t: w.t, h: w.h, d: w.d, missing: w.missing, distinct: w.frames.size }; },
    // For every frame of window b, the fewest pixels by which it differs from any frame of the windows in a.
    compare(as, b) {
      const out = [];
      for (const [h, px] of windows[b].frames) {
        let best = Infinity;
        for (const a of as) for (const other of windows[a].frames.values()) {
          let n = 0;
          for (let i = 0; i < px.length; i += 4)
            if (Math.abs(px[i] - other[i]) + Math.abs(px[i + 1] - other[i + 1]) + Math.abs(px[i + 2] - other[i + 2]) + Math.abs(px[i + 3] - other[i + 3]) > 48) n++;
          if (n < best) best = n;
        }
        out.push({ h, minDiff: best });
      }
      return out;
    },
    has(label, h) { return windows[label].frames.has(h); },
  };
})();
`;

type Window = { t: number[]; h: number[]; d: number[]; missing: number; distinct: number };
const read = (label: string) => evaluate<Window>(`window.__mm.read(${JSON.stringify(label)})`);
const startWindow = (label: string, find: string) =>
  evaluate(`(window.__mm.start(${JSON.stringify(label)}, ${JSON.stringify(find)}), true)`);
const stopWindow = (label: string) =>
  evaluate(`(window.__mm.stop(${JSON.stringify(label)}), true)`);
const compare = (against: string[], label: string) =>
  evaluate<{ h: number; minDiff: number }[]>(
    `window.__mm.compare(${JSON.stringify(against)}, ${JSON.stringify(label)})`,
  );

/**
 * Episodes of motion in a window: the mascot is never still (it breathes, the frame differs by a
 * few pixels each sample), and a blink or a wobble is a run of samples that differ far more from
 * their predecessors than the median does. An episode starts at the first such sample after
 * `quietMs` without one; the first half second is the canvas settling and is skipped.
 */
function bursts(w: Window, quietMs = 800) {
  const sorted = [...w.d].sort((x, y) => x - y);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const threshold = Math.max(3 * median, median + 40);
  const starts: number[] = [];
  let last = -Infinity;
  for (let i = 1; i < w.d.length; i++) {
    if (w.t[i]! < 500 || w.d[i]! <= threshold) continue;
    if (w.t[i]! - last > quietMs) starts.push(w.t[i]!);
    last = w.t[i]!;
  }
  return starts;
}
const changes = (w: Window) => w.h.filter((h, i) => i > 0 && h !== w.h[i - 1]).length;

const tile = (index: number) =>
  `document.querySelectorAll('[data-agent-avatar-dialog] [role=radiogroup] > label')[${index}]?.querySelector('canvas')`;
const header = (peer: Peer) =>
  `[...document.querySelectorAll('[role=img]')].find((e) => e.getAttribute('aria-label')?.startsWith(${JSON.stringify(`${peer.name}, `)}) && !e.closest('a'))?.querySelector('canvas')`;
const headerLabel = (peer: Peer) =>
  `[...document.querySelectorAll('[role=img]')].find((e) => e.getAttribute('aria-label')?.startsWith(${JSON.stringify(`${peer.name}, `)}) && !e.closest('a'))?.getAttribute('aria-label')`;

const mouse = (x: number, y: number) => browser("mouse", "move", String(x), String(y));
const setTheme = (dark: boolean) =>
  evaluate(`(document.documentElement.classList.toggle('dark-mode', ${dark}), true)`);
async function shoot(name: string) {
  for (const dark of [false, true]) {
    await setTheme(dark);
    await Bun.sleep(300);
    await browser("screenshot", join(artifacts, `${name}-${dark ? "dark" : "light"}.png`));
  }
  await setTheme(false);
}

// A display revision is microseconds since the epoch, and the page's own read of an idle Agent
// is stamped when it is read: a published one must be newer than that.
let lastRevision = 0;

function display(peer: Peer, activityKind: "working" | "thinking"): AgentDisplaySnapshot {
  lastRevision = Math.max(lastRevision + 1, Date.now() * 1000);
  return {
    protocolMajor: 1,
    workspaceId,
    computerId,
    agentId: peer.agentId,
    revision: lastRevision,
    activityKind,
    detailKind: activityKind === "working" ? "running_command" : "thinking_started",
    detail: activityKind === "working" ? "Running command" : "",
    entries: [],
    expiresAt: Date.now() + 120_000,
  };
}

/** Publishes a display snapshot as the cloud does and waits for the header's face to name it. */
async function show(peer: Peer, snapshot: AgentDisplaySnapshot) {
  const label = `${peer.name}, ${agentDisplay(snapshot).label}`;
  // Published again until shown: the page's status subscription may still be joining, and a
  // repeated revision is the same snapshot to it.
  for (let attempt = 0; attempt < 10; attempt++) {
    await centrifugo.publishJson(agentStatusChannel(workspaceId), {
      type: "agent:display",
      ...snapshot,
    });
    for (let poll = 0; poll < 10; poll++) {
      if ((await evaluate<string | null>(headerLabel(peer))) === label) return;
      await Bun.sleep(200);
    }
  }
  throw new Error(
    `the header never read "${label}"; it reads "${await evaluate(headerLabel(peer))}"`,
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
      displayName: "Motion reviewer",
      welcomedAt: new Date(),
    },
  });
  const workspace = await db.workspace.create({
    data: {
      name: "Mascot motion",
      slug: `mascot-motion-${process.pid}`,
      members: { create: [{ userId: DEV_BROWSER_USER.id, role: "owner" }] },
    },
  });
  workspaceId = workspace.id;
  workspaceSlug = workspace.slug;
  const computer = await db.computer.create({
    data: { ownerId: DEV_BROWSER_USER.id, machineId: `mascot-motion-${process.pid}` },
  });
  computerId = computer.id;
  const dms = new PrismaDirectConversationRepository(db);
  for (const peer of peers) {
    peer.agentId = (
      await db.agent.create({
        data: {
          workspaceId,
          ownerId: DEV_BROWSER_USER.id,
          computerId,
          name: `motion-${peer.mascot}`,
          // Public, so its displays arrive on the Workspace's own status channel.
          visibility: "public",
          displayName: peer.name,
          avatarMascot: peer.mascot,
          runtimeConfig: {
            runtime: "pi",
            provider: { kind: "default" },
            model: "e2e-model",
            modelProvider: "e2e-provider",
            reasoning: "balanced",
          },
        },
      })
    ).id;
    peer.conversationId = (
      await dms.getOrCreateUserAgent(workspaceId, DEV_BROWSER_USER.id, peer.agentId)
    ).id;
  }
});

afterAll(async () => {
  await browser("close");
  proxy.stop();
  if (workspaceId) await db.workspace.delete({ where: { id: workspaceId } });
  if (computerId) await db.computer.delete({ where: { id: computerId } });
  await db.$disconnect();
});

test("in the picker the five new mascots idle with blinks and react to the pointer", async () => {
  const first = peers[0]!;
  await browser("set", "viewport", "1440", "900");
  await browser("set", "media", "light");
  await browser(
    "open",
    `${proxy.origin}/en/w/${workspaceSlug}/dm/${first.conversationId}?profile=agent:${first.agentId}`,
  );
  await browser("wait", '[aria-label="Change mascot"]');
  await browser("click", '[aria-label="Change mascot"]');
  await browser(
    "wait",
    "--fn",
    `document.querySelectorAll('[data-agent-avatar-dialog] canvas').length === 12`,
  );
  expect(await evaluate<boolean>(`matchMedia('(prefers-reduced-motion: reduce)').matches`)).toBe(
    false,
  );
  await browser("eval", SAMPLER);
  const indexOf = (id: MascotId) => MASCOT_IDS.indexOf(id);

  // 1. Idle, the pointer parked off the dialog so the eyes have nothing to follow.
  await mouse(8, 8);
  await Bun.sleep(1_500);
  const IDLE_MS = 16_000;
  for (const id of NEW_MASCOTS) await startWindow(`idle-${id}`, tile(indexOf(id)));
  await Bun.sleep(IDLE_MS);
  const report: Record<string, unknown> = {};
  const idle: Record<string, Window> = {};
  for (const id of NEW_MASCOTS) {
    await stopWindow(`idle-${id}`);
    idle[id] = await read(`idle-${id}`);
    const starts = bursts(idle[id]);
    report[`idle-${id}`] = {
      samples: idle[id].h.length,
      distinctFrames: idle[id].distinct,
      changes: changes(idle[id]),
      burstStartsMs: starts,
      t: idle[id].t,
      d: idle[id].d,
      gapsMs: starts.slice(1).map((s, i) => s - starts[i]!),
    };
  }
  await shoot("picker");
  await Bun.write(join(artifacts, "idle.json"), JSON.stringify(report, null, 2));

  // 2. Hover. Per mascot: the pointer just left of the tile, just right of it (neither is over the
  // tile; both are the same distance from its centre, so the eyes look the same way mirrored), and
  // then on its centre.
  const hover: Record<string, unknown> = {};
  for (const id of NEW_MASCOTS) {
    const box = await evaluate<{ x: number; y: number; w: number }>(
      `(() => { const r = document.querySelectorAll('[data-agent-avatar-dialog] [role=radiogroup] > label')[${indexOf(id)}].getBoundingClientRect(); return { x: r.left, y: r.top + r.height / 2, w: r.width }; })()`,
    );
    const find = tile(indexOf(id));
    const spots = { left: box.x - 7, right: box.x + box.w + 7, over: box.x + box.w / 2 } as const;
    for (const [where, x] of Object.entries(spots)) {
      await mouse(Math.round(x), Math.round(box.y));
      await Bun.sleep(1_200);
      await startWindow(`${where}-${id}`, find);
      await Bun.sleep(6_000);
      await stopWindow(`${where}-${id}`);
    }
    const eyesOnly = Math.max(
      ...(await compare([`left-${id}`], `right-${id}`)).map((f) => f.minDiff),
    );
    const overFrames = await compare([`left-${id}`, `right-${id}`], `over-${id}`);
    const reaction = Math.max(...overFrames.map((f) => f.minDiff));
    hover[id] = { eyesOnlyPixels: eyesOnly, hoverPixels: reaction, overFrames: overFrames.length };
    await mouse(8, 8);
    await Bun.sleep(500);
  }
  await Bun.write(join(artifacts, "hover.json"), JSON.stringify(hover, null, 2));

  for (const id of NEW_MASCOTS) {
    // Each moves while idle, in episodes a few seconds apart.
    expect(idle[id]!.missing, `${id} canvas present`).toBe(0);
    expect(idle[id]!.distinct, `${id} idle distinct frames`).toBeGreaterThanOrEqual(2);
    const starts = bursts(idle[id]!);
    expect(starts.length, `${id} idle bursts in ${IDLE_MS} ms`).toBeGreaterThanOrEqual(3);
    for (const [i, start] of starts.slice(1).entries()) {
      const gap = start - starts[i]!;
      expect(gap, `${id} gap between idle bursts`).toBeGreaterThan(1_500);
      expect(gap, `${id} gap between idle bursts`).toBeLessThan(6_000);
    }
    // Hover shows a pose that the eyes alone do not make.
    const h = hover[id] as { eyesOnlyPixels: number; hoverPixels: number };
    expect(h.hoverPixels, `${id} hover pixels vs eyes-only ${h.eyesOnlyPixels}`).toBeGreaterThan(
      Math.max(30, h.eyesOnlyPixels * 2),
    );
  }
}, 420_000);

test("an Agent's header mascot moves while thinking and while working, and differently", async () => {
  await browser("set", "viewport", "1440", "900");
  await browser("set", "media", "light");
  const report: Record<string, unknown> = {};
  const checks: (() => void)[] = [];
  for (const peer of peers) {
    await browser("open", `${proxy.origin}/en/w/${workspaceSlug}/dm/${peer.conversationId}`);
    await browser("wait", "--fn", `${headerLabel(peer)} != null && !!(${header(peer)})`);
    await browser("eval", SAMPLER);
    await mouse(700, 700);
    await Bun.sleep(1_500);
    const find = header(peer);
    const sample = async (label: string, ms: number) => {
      await startWindow(label, find);
      await Bun.sleep(ms);
      await stopWindow(label);
      return read(label);
    };
    const idle = await sample("idle", 6_000);
    // Control: a second idle window. Idle repeats itself, so its frames are the first one's.
    const idleAgain = await sample("idle-again", 4_000);
    await show(peer, display(peer, "thinking"));
    await Bun.sleep(800);
    const thinking = await sample("thinking", 4_000);
    await show(peer, display(peer, "working"));
    await Bun.sleep(800);
    const working = await sample("working", 4_000);
    await shoot(`working-${peer.mascot}`);
    const workingNew = await compare(["idle", "thinking"], "working");
    const thinkingNew = await compare(["idle"], "thinking");
    const idleAgainNew = await compare(["idle"], "idle-again");
    const stats = {
      idle: { distinct: idle.distinct, changes: changes(idle) },
      thinking: { distinct: thinking.distinct, changes: changes(thinking) },
      working: { distinct: working.distinct, changes: changes(working) },
      idleFramesNotInIdle: idleAgainNew.filter((f) => f.minDiff > 30).length,
      thinkingFramesNotInIdle: thinkingNew.filter((f) => f.minDiff > 30).length,
      workingFramesNotInIdleOrThinking: workingNew.filter((f) => f.minDiff > 30).length,
    };
    report[peer.mascot] = stats;
    checks.push(() => {
      expect(idle.missing + thinking.missing + working.missing, `${peer.mascot} canvas`).toBe(0);
      expect(
        stats.thinking.distinct,
        `${peer.mascot} thinking distinct frames`,
      ).toBeGreaterThanOrEqual(2);
      expect(
        stats.working.distinct,
        `${peer.mascot} working distinct frames`,
      ).toBeGreaterThanOrEqual(2);
      // The control: a repeat of idle is not mistaken for something new.
      expect(stats.idleFramesNotInIdle, `${peer.mascot} idle frames unlike idle`).toBeLessThan(
        idleAgain.distinct / 4,
      );
      expect(
        stats.thinkingFramesNotInIdle,
        `${peer.mascot} thinking frames unlike idle`,
      ).toBeGreaterThan(0);
      expect(
        stats.workingFramesNotInIdleOrThinking,
        `${peer.mascot} working frames unlike idle and thinking`,
      ).toBeGreaterThan(0);
    });
  }
  await Bun.write(join(artifacts, "activity.json"), JSON.stringify(report, null, 2));
  for (const check of checks) check();
}, 300_000);
