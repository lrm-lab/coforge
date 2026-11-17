import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { productionArtifacts } from "#src/server/artifacts/artifact-composition.server";
import { PrismaExperimentsRepository } from "#src/server/experiments/experiments.repositories.server";
import { readFeatureFlagsConfiguration } from "#src/server/feature-flags/configuration.server";
import { installFeatureFlags } from "#src/server/feature-flags/feature-flags.server";
import { agentWrites } from "./helpers/artifact-agent-writes";
import {
  browserSession,
  devBrowserWorkspace,
  localBrowserE2e,
  pageHydrated,
} from "./helpers/browser-e2e";
import { sameOriginProxy } from "./helpers/same-origin-proxy";

/**
 * People comment on an element and on a text selection inside an HTML artifact's page. A person
 * turns comment mode on, picks an element with a real mouse (the page is in a frame of its own
 * origin, so only trusted input reaches it), writes the comment, and the thread names the element
 * and is marked in the frame; a second person's comment appears there live; a new version without
 * the element shows the thread as changed. A page script that posts a forged "picked" message,
 * posted with comment mode off, and with it on but no click of the person, opens no composer; one
 * posted right after the person presses "pick element" does open it, showing the page's label, and
 * nothing is posted until the person sends. The test page posts its forgeries on command and then
 * a message the host visibly handles (its error banner), which proves the forgeries were handled.
 *
 * Opt-in like the other browser E2Es: the Web with the flag file that offers `artifacts`,
 * `COFORGE_ARTIFACT_SANDBOX_ORIGIN` on another host of the same server, `COFORGE_SESSION_SECRET`,
 * and a Centrifugo the Web is reachable from (`COFORGE_E2E_CENTRIFUGO_URL`). Screenshots go to
 * `COFORGE_E2E_SHOTS_DIR`, else `.amp/e2e/artifact-element-comments/`.
 */
const { origin: webOrigin, browserPath, databaseUrl } = localBrowserE2e();
const centrifugoOrigin = Bun.env.COFORGE_E2E_CENTRIFUGO_URL;
if (!centrifugoOrigin) throw new Error("COFORGE_E2E_CENTRIFUGO_URL is required");
if (!Bun.env.COFORGE_ARTIFACT_SANDBOX_ORIGIN)
  throw new Error("COFORGE_ARTIFACT_SANDBOX_ORIGIN is required");
const shots =
  Bun.env.COFORGE_E2E_SHOTS_DIR ??
  join(import.meta.dir, "../../../.amp/e2e/artifact-element-comments");
const locale = Bun.env.COFORGE_E2E_LOCALE ?? "en";
const [width, height] = (Bun.env.COFORGE_E2E_VIEWPORT ?? "1280x860").split("x");

const page = (tail: string, withTitle: boolean) => `<!doctype html><html><head><title>Launch</title>
<style>body{margin:0;font:16px sans-serif;height:1600px}main>*{position:absolute;margin:0}</style></head><body>
<main>
${withTitle ? '<h1 id="title" style="left:20px;top:60px;width:200px;height:40px">Launch plan</h1>' : ""}
<p style="left:20px;top:140px;width:520px;height:24px">Ship the beta on Friday. Pricing is open for review ${tail}.</p>
<button data-testid="buy" style="left:20px;top:220px;width:120px;height:32px">Buy now</button>
</main>
<script>
const forgedPick = { jsonrpc: "2.0", method: "coforge/notifications/annotate-selected", params: { type: "element", data: { selector: "h1", quote: "forged" }, rect: { top: 60, right: 220, bottom: 100, left: 20, width: 200, height: 40 } } };
const tell = (message) => parent.postMessage({ jsonrpc: "2.0", method: "coforge/notifications/error", params: { message } }, "*");
addEventListener("message", (event) => {
  if (!event.data || typeof event.data.forge !== "string") return;
  for (let round = 0; round < 5; round += 1) parent.postMessage(forgedPick, "*");
  tell("forged:" + event.data.forge);
});
tell("ready");
</script></body></html>`;

test("people comment on a page element and a text selection; marks show in the frame, live, on the version they were written on", async () => {
  await installFeatureFlags(
    await readFeatureFlagsConfiguration({
      COFORGE_FEATURE_FLAGS_FILE: "/tmp/coforge-flags-docs.json",
    }),
  );
  const proxy = sameOriginProxy(webOrigin, centrifugoOrigin, {});
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const session = browserSession(browserPath, `artifact-elements-${process.pid}`);
  const { browser, evaluate, waitFor } = session;
  const experiments = new PrismaExperimentsRepository(db);
  const services = productionArtifacts(db);
  const { workspaceId, workspace } = await devBrowserWorkspace(db);
  const before = (await experiments.read(workspaceId)).artifacts;
  const tail = `${process.pid}-${Date.now()}`.slice(-6);
  const agent = await db.agent.create({
    data: {
      workspaceId,
      name: `e2e-el-${tail}`,
      displayName: "Scribe",
      ownerId: DEV_BROWSER_USER.id,
      runtimeConfig: {},
    },
  });
  const lin = await db.user.create({ data: { username: `lin-e-${tail}`, displayName: "Lin Xia" } });
  await db.workspaceMembership.create({ data: { workspaceId, userId: lin.id } });
  const channel = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `e2e-el-${tail}`,
      description: "",
      members: {
        create: [{ userId: DEV_BROWSER_USER.id }, { userId: lin.id }, { agentId: agent.id }],
      },
    },
  });
  const bot = agentWrites(services, workspaceId, agent.id);
  let artifact: Awaited<ReturnType<typeof bot.create>>;
  const shoot = async (shot: string) => {
    await waitFor(`document.getAnimations().every((a) => a.playState !== "running")`);
    await browser("screenshot", join(shots, `${shot}.png`));
  };
  const click = (selector: string) =>
    browser(
      "eval",
      `(() => { const target = document.querySelector(${JSON.stringify(selector)}); target?.click(); return Boolean(target); })()`,
    );
  const frameOrigin = () =>
    evaluate<{ x: number; y: number }>(
      `(() => { const r = document.querySelector("main iframe").getBoundingClientRect(); return { x: r.x, y: r.y }; })()`,
    );
  const mouse = (action: string, ...args: number[]) =>
    browser("mouse", action, ...args.map(String));
  const bannerShown = `[...document.querySelectorAll('[role="alert"]')].length > 0`;
  const handled = async () => {
    await waitFor(bannerShown);
    await browser(
      "eval",
      `[...document.querySelectorAll('[role="alert"] button')].find((button) => button.textContent.trim() === "Close")?.click()`,
    );
    await waitFor(`document.querySelectorAll('[role="alert"]').length === 0`);
  };
  const forge = async (tag: string) => {
    await browser(
      "eval",
      `document.querySelector("main iframe").contentWindow.postMessage({ forge: ${JSON.stringify(tag)} }, "*")`,
    );
    await handled();
  };
  const pillPosition = () =>
    evaluate<{ x: number; y: number }>(
      `(() => { const r = document.querySelector("[data-pick-element]").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
    );
  const pressPill = async () => {
    const at = await pillPosition();
    await mouse("move", at.x, at.y);
    await mouse("down");
    await mouse("up");
  };
  const picking = (on: boolean) =>
    waitFor(
      `document.querySelector("[data-pick-element]")?.getAttribute("aria-pressed") === "${on}" && window.__modeAcks.at(-1) === ${on}`,
    );
  const commentCount = () => db.artifactComment.count({ where: { artifactId: artifact.id } });
  const hasPopover = `document.querySelector("[data-comment-popover]") != null`;
  const statusOf = (id: string) =>
    `document.querySelector('[data-comment-thread="${id}"] [data-comment-anchor]')?.dataset.anchorStatus`;
  try {
    await experiments.write(workspaceId, "artifacts", true);
    await mkdir(shots, { recursive: true });
    await browser("set", "viewport", width!, height!);
    artifact = await bot.create({
      conversationId: channel.id,
      title: "Launch page",
      files: { "index.html": page(tail, true) },
      entry: "index.html",
    });
    await browser("open", `${proxy.origin}/${locale}/w/${workspace.slug}/artifacts/${artifact.id}`);
    await waitFor(`${pageHydrated} && document.querySelector("main iframe") != null`, 60_000);
    await handled();
    await browser(
      "eval",
      `window.__modeAcks = []; addEventListener("message", (event) => { if (event.data?.method === "coforge/notifications/annotate-mode") window.__modeAcks.push(event.data.params.picking); })`,
    );

    await forge("comment-mode-off");
    expect(await evaluate<boolean>(hasPopover)).toBe(false);

    await click("button[aria-pressed]");
    await waitFor(`document.querySelector("[data-comment-tools]") != null`);
    await picking(true);
    await forge("no-click-by-the-person");
    expect(await evaluate<boolean>(hasPopover)).toBe(false);
    expect(
      await evaluate<boolean>(`document.querySelector("[data-comment-selection]") != null`),
    ).toBe(false);
    await shoot("20-comment-mode-html");

    await pressPill();
    await picking(false);
    await pressPill();
    await picking(true);
    await forge("after-the-person-pressed-pick");
    await waitFor(
      `document.querySelector("[data-comment-popover]")?.textContent.includes("forged")`,
    );
    expect(await commentCount()).toBe(0);
    expect(await evaluate<boolean>(`document.querySelector("[data-pick-element]").disabled`)).toBe(
      true,
    );
    await click("[data-comment-popover] button");
    await waitFor(`document.querySelector("[data-comment-popover]") == null`);
    expect(await commentCount()).toBe(0);

    await browser("find", "role", "button", "click", "--name", "Comment options");
    await browser("find", "role", "menuitem", "click", "--name", "All comments");
    await waitFor(`document.querySelector('aside[aria-label="Comments"]') != null`);
    await pressPill();
    await picking(true);
    const origin = await frameOrigin();
    await mouse("move", origin.x + 60, origin.y + 80);
    await shoot("23-element-picker-hover");
    await mouse("down");
    await mouse("up");
    await waitFor(hasPopover);
    await waitFor(
      `document.querySelector("[data-comment-popover]").textContent.includes("Launch plan")`,
    );
    await browser("fill", "[data-comment-popover] textarea", `Make the title shorter ${tail}`);
    await shoot("24-element-composer");
    await click('[data-comment-popover] button[type="submit"]');
    await waitFor(`document.querySelector("[data-comment-popover]") == null`);
    await waitFor(
      `document.querySelector("[data-comment-thread]")?.textContent.includes("Launch plan")`,
    );
    const mine = await evaluate<string>(
      `document.querySelector("[data-comment-thread]").dataset.commentThread`,
    );
    await waitFor(`${statusOf(mine)} === "found"`);

    const onButton = await services.comments.post({
      workspaceId,
      userId: lin.id,
      artifactId: artifact.id,
      comment: {
        body: `Is this the right label ${tail}`,
        path: "index.html",
        anchor: {
          type: "element",
          data: { selector: 'button[data-testid="buy"]', quote: "Buy now" },
        },
        idempotencyKey: `e2e-${tail}-button`,
      },
    });
    await waitFor(`${statusOf(onButton.id)} === "found"`);
    await shoot("38-element-marks");

    await mouse("move", origin.x + 600, origin.y + 600);
    await mouse("move", origin.x + 21, origin.y + 152);
    await mouse("down");
    await mouse("move", origin.x + 200, origin.y + 152);
    await mouse("up");
    await waitFor(`document.querySelector("[data-comment-selection]") != null`);
    await click("[data-comment-selection] button");
    await waitFor(
      `document.querySelector("[data-comment-popover]")?.textContent.includes("Ship the")`,
    );
    await browser("fill", "[data-comment-popover] textarea", `Is Friday firm ${tail}?`);
    await click('[data-comment-popover] button[type="submit"]');
    await waitFor(`document.querySelector("[data-comment-popover]") == null`);
    await waitFor(
      `[...document.querySelectorAll("[data-comment-thread]")].some((thread) => thread.textContent.includes("Is Friday firm ${tail}") && thread.textContent.includes("Ship the"))`,
    );

    await mouse("move", origin.x + 600, origin.y + 600);
    await mouse("move", origin.x + 224, origin.y + 52);
    await mouse("down");
    await mouse("up");
    await waitFor(
      `document.querySelector('[data-comment-thread="${mine}"]')?.classList.contains("ring-2")`,
    );

    const revised = { "index.html": page(tail, false) };
    await bot.push(artifact.id, 1, revised).catch(() => bot.push(artifact.id, 1, revised));
    await waitFor(`document.querySelector('[role="status"] button') != null`);
    await click('[role="status"] button');
    await waitFor(
      `${statusOf(mine)} === "elsewhere" && ${statusOf(onButton.id)} === "elsewhere"`,
      30_000,
    );
    await click(`[data-comment-thread="${onButton.id}"] [data-comment-anchor]`);
    await waitFor(`${statusOf(mine)} === "found" && ${statusOf(onButton.id)} === "found"`, 30_000);
  } finally {
    await browser("close").catch(() => undefined);
    proxy.stop();
    await experiments.write(workspaceId, "artifacts", before);
    await db.artifact
      .deleteMany({ where: { homeKey: `conversation:${channel.id}` } })
      .catch(() => undefined);
    await db.conversation.delete({ where: { id: channel.id } }).catch(() => undefined);
    await db.agent.delete({ where: { id: agent.id } }).catch(() => undefined);
    await db.workspaceMembership.deleteMany({ where: { workspaceId, userId: lin.id } });
    await db.user.delete({ where: { id: lin.id } }).catch(() => undefined);
    await db.$disconnect();
  }
}, 240_000);
