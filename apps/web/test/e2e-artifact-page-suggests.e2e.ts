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

const { origin: webOrigin, browserPath, databaseUrl } = localBrowserE2e();
const centrifugoOrigin = Bun.env.COFORGE_E2E_CENTRIFUGO_URL;
if (!centrifugoOrigin) throw new Error("COFORGE_E2E_CENTRIFUGO_URL is required");
if (!Bun.env.COFORGE_ARTIFACT_SANDBOX_ORIGIN)
  throw new Error("COFORGE_ARTIFACT_SANDBOX_ORIGIN is required");
const shots =
  Bun.env.COFORGE_E2E_SHOTS_DIR ??
  join(import.meta.dir, "../../../.artifacts/e2e/artifact-page-suggests");
const locale = Bun.env.COFORGE_E2E_LOCALE ?? "en";
const [width, height] = (Bun.env.COFORGE_E2E_VIEWPORT ?? "1280x860").split("x");

const page = (tail: string) => `<!doctype html><html><head><title>Plans</title>
<style>body{margin:0;font:16px sans-serif;height:1200px}main>*{position:absolute;margin:0}</style></head><body>
<main>
<h1 style="left:20px;top:60px">Plans ${tail}</h1>
<button id="suggest" style="left:20px;top:140px;width:220px;height:36px">Suggest a comment</button>
</main>
<script>
const reply = (e2e) => parent.postMessage({ e2e }, "*");
const comments = window.coforge.use("comments");
const open = async () => {
  const api = await comments;
  return api.open(
    { name: "plan:two", label: "Plan two", quote: "Ships on Friday" },
    { draft: "Is Friday still right?\\nPlease confirm." },
  );
};
document.getElementById("suggest").onclick = () => void open();
addEventListener("message", async (event) => {
  if (event.data && event.data.ping) reply("pong");
  if (event.data && event.data.suggestWithoutClick) reply("no-click:" + (await open()));
});
</script></body></html>`;

test("a page suggests a comment from a click: the box opens with the page's text and says so, the person edits and posts, and a call with no click opens nothing", async () => {
  await installFeatureFlags(
    await readFeatureFlagsConfiguration({
      COFORGE_FEATURE_FLAGS_FILE: "/tmp/coforge-flags-docs.json",
    }),
  );
  const proxy = sameOriginProxy(webOrigin, centrifugoOrigin, {});
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const session = browserSession(browserPath, `artifact-page-suggests-${process.pid}`);
  const { browser, evaluate, waitFor } = session;
  const experiments = new PrismaExperimentsRepository(db);
  const services = productionArtifacts(db);
  const { workspaceId, workspace } = await devBrowserWorkspace(db);
  const before = (await experiments.read(workspaceId)).artifacts;
  const tail = `${process.pid}-${Date.now()}`.slice(-6);
  const agent = await db.agent.create({
    data: {
      workspaceId,
      name: `e2e-ps-${tail}`,
      displayName: "Scribe",
      ownerId: DEV_BROWSER_USER.id,
      runtimeConfig: {},
    },
  });
  const channel = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `e2e-ps-${tail}`,
      description: "",
      members: { create: [{ userId: DEV_BROWSER_USER.id }, { agentId: agent.id }] },
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
  const heard = (word: string) =>
    `(document.querySelector("main iframe")?.contentWindow.postMessage({ ping: true }, "*"), (window.__e2e ?? []).includes(${JSON.stringify(word)}))`;
  const hasPopover = `document.querySelector("[data-comment-popover]") != null`;
  try {
    await experiments.write(workspaceId, "artifacts", true);
    await mkdir(shots, { recursive: true });
    await browser("set", "viewport", width!, height!);
    artifact = await bot.create({
      conversationId: channel.id,
      title: "Plans page",
      files: { "index.html": page(tail) },
      entry: "index.html",
    });
    await browser("open", `${proxy.origin}/${locale}/w/${workspace.slug}/artifacts/${artifact.id}`);
    await waitFor(`${pageHydrated} && document.querySelector("main iframe") != null`, 60_000);
    await browser(
      "eval",
      `window.__e2e = []; addEventListener("message", (event) => event.data && event.data.e2e && window.__e2e.push(event.data.e2e))`,
    );
    await waitFor(heard("pong"), 30_000);

    await browser(
      "eval",
      `document.querySelector("main iframe").contentWindow.postMessage({ suggestWithoutClick: true }, "*")`,
    );
    await waitFor(heard("no-click:false"));
    expect(await evaluate<boolean>(hasPopover)).toBe(false);

    const frame = await evaluate<{ x: number; y: number }>(
      `(() => { const r = document.querySelector("main iframe").getBoundingClientRect(); return { x: r.x, y: r.y }; })()`,
    );
    await browser("mouse", "move", String(frame.x + 100), String(frame.y + 158));
    await browser("mouse", "down");
    await browser("mouse", "up");
    await waitFor(hasPopover);
    await waitFor(`document.querySelector("[data-comment-popover] [data-page-suggested]") != null`);
    await waitFor(
      `document.querySelector("[data-comment-popover]").textContent.includes("Ships on Friday")`,
    );
    expect(
      await evaluate<string>(`document.querySelector("[data-comment-popover] textarea").value`),
    ).toBe("Is Friday still right?\nPlease confirm.");
    await shoot("80-page-suggests");

    await browser("fill", "[data-comment-popover] textarea", `Is Friday still right ${tail}?`);
    await waitFor(`document.querySelector("[data-comment-popover] [data-page-suggested]") != null`);
    await click('[data-comment-popover] button[type="submit"]');
    await waitFor(`document.querySelector("[data-comment-popover]") == null`);
    const posted = await db.artifactComment.findFirstOrThrow({
      where: { artifactId: artifact.id },
    });
    expect(posted.body).toBe(`Is Friday still right ${tail}?`);
    expect(posted.anchor).toEqual({
      type: "page",
      data: { name: "plan:two", label: "Plan two", quote: "Ships on Friday" },
    });
    await click("button[aria-pressed]");
    await waitFor(
      `[...document.querySelectorAll("[data-comment-thread]")].some((thread) => thread.textContent.includes("Plan two") && thread.textContent.includes("Ships on Friday"))`,
    );
    await shoot("81-page-suggested-posted");
  } finally {
    await browser("close").catch(() => undefined);
    proxy.stop();
    await experiments.write(workspaceId, "artifacts", before);
    await db.artifact
      .deleteMany({ where: { homeKey: `conversation:${channel.id}` } })
      .catch(() => undefined);
    await db.conversation.delete({ where: { id: channel.id } }).catch(() => undefined);
    await db.agent.delete({ where: { id: agent.id } }).catch(() => undefined);
    await db.$disconnect();
  }
}, 240_000);
