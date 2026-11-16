import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { productionArtifacts } from "#src/server/artifacts/artifact-composition.server";
import { agentWrites } from "./helpers/artifact-agent-writes";
import { artifactChrome } from "./helpers/artifact-chrome";
import { versionChromeSteps } from "./helpers/artifact-version-steps";
import { PrismaExperimentsRepository } from "#src/server/experiments/experiments.repositories.server";
import { readFeatureFlagsConfiguration } from "#src/server/feature-flags/configuration.server";
import { installFeatureFlags } from "#src/server/feature-flags/feature-flags.server";
import {
  browserSession,
  devBrowserWorkspace,
  localBrowserE2e,
  pageHydrated,
} from "./helpers/browser-e2e";
import { sameOriginProxy } from "./helpers/same-origin-proxy";

/**
 * An artifact's own page, which people only view: a web page's preview from its artifact's own
 * origin with its version chip and switcher; the live "published vN" banner with View latest
 * when an Agent saves while the page shows (the page keeps the version it shows until then);
 * "Viewing vN" with Back to latest; the files panel; rename, which only who manages its sharing
 * sees; one page for an artifact that is not there and one that is not the reader's, which opens
 * read only once moved to the Workspace; a `?doc=` link opening it beside the chat; a document's
 * text, kept when a refresh fails and gone when the artifact is deleted; and a first read that
 * fails, with Try again.
 *
 * Opt-in like the other browser E2Es: real local Web started with the flag file that offers
 * `artifacts` (`/tmp/coforge-flags-docs.json`, read here too), with
 * `COFORGE_ARTIFACT_SANDBOX_ORIGIN` on another host of the same server
 * (`http://localhost:<port>` beside `127.0.0.1`), a `COFORGE_SESSION_SECRET`, which signs the
 * sandbox's links, and a Centrifugo the Web is reachable from (`COFORGE_E2E_CENTRIFUGO_URL`),
 * which carries the banner. Its texts carry the run's tail, since bytes are stored once per
 * Workspace by their hash. Screenshots go under `.amp/e2e/artifact-page/`.
 */
const { origin: webOrigin, browserPath, databaseUrl } = localBrowserE2e();
const centrifugoOrigin = Bun.env.COFORGE_E2E_CENTRIFUGO_URL;
if (!centrifugoOrigin) throw new Error("COFORGE_E2E_CENTRIFUGO_URL is required");
const sandboxOrigin = Bun.env.COFORGE_ARTIFACT_SANDBOX_ORIGIN;
if (!sandboxOrigin) throw new Error("COFORGE_ARTIFACT_SANDBOX_ORIGIN is required");
const artifacts = join(import.meta.dir, "../../../.amp/e2e/artifact-page");

test("an artifact's page: a web page, the page that is not there, an old link, a failed read", async () => {
  await installFeatureFlags(
    await readFeatureFlagsConfiguration({
      COFORGE_FEATURE_FLAGS_FILE: "/tmp/coforge-flags-docs.json",
    }),
  );
  let refusing = false;
  /** Refuses only the server calls that read this artifact. */
  let refusingFor: string | null = null;
  const proxy = sameOriginProxy(webOrigin, centrifugoOrigin, {
    refuse: (url) => {
      if (!url.pathname.includes("/_serverFn/")) return false;
      if (refusing) return true;
      // Every call's payload names the page; only a read of the artifact names it as its data.
      const payload = decodeURIComponent(url.search);
      return (
        refusingFor !== null && payload.includes('"artifactId"') && payload.includes(refusingFor)
      );
    },
  });
  const origin = proxy.origin;
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const session = browserSession(browserPath, `artifact-page-${process.pid}`);
  const { browser, evaluate } = session;
  const chrome = artifactChrome(session);
  const experiments = new PrismaExperimentsRepository(db);
  const services = productionArtifacts(db);
  const { workspaceId, workspace } = await devBrowserWorkspace(db);
  const before = (await experiments.read(workspaceId)).artifacts;
  const devRole = (
    await db.workspaceMembership.findFirstOrThrow({
      where: { workspaceId, userId: DEV_BROWSER_USER.id },
    })
  ).role;
  const tail = `${process.pid}-${Date.now()}`.slice(-6);
  const agent = await db.agent.create({
    data: {
      workspaceId,
      name: `e2e-page-${tail}`,
      displayName: "Scribe",
      ownerId: DEV_BROWSER_USER.id,
      runtimeConfig: {},
    },
  });
  const lin = await db.user.create({ data: { username: `lin-p-${tail}`, displayName: "Lin Xia" } });
  await db.workspaceMembership.create({ data: { workspaceId, userId: lin.id } });
  const channel = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `e2e-page-${tail}`,
      description: "",
      members: { create: [{ userId: DEV_BROWSER_USER.id }, { agentId: agent.id }] },
    },
  });
  const linAgent = await db.agent.create({
    data: {
      workspaceId,
      name: `e2e-page-lin-bot-${tail}`,
      displayName: "Lin's bot",
      ownerId: lin.id,
      runtimeConfig: {},
    },
  });
  // Lin's private channel, which the viewer is not in.
  const closed = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `e2e-closed-${tail}`,
      description: "",
      visibility: "private",
      members: { create: [{ userId: lin.id }, { agentId: linAgent.id }] },
    },
  });
  const bot = agentWrites(services, workspaceId, agent.id);
  const linBot = agentWrites(services, workspaceId, linAgent.id);
  const settled = () =>
    browser("wait", "--fn", `document.getAnimations().every((a) => a.playState !== "running")`);
  const shoot = async (shot: string) => {
    await settled();
    await browser("screenshot", join(artifacts, `${shot}.png`));
  };
  const text = (needle: string) => `document.body.textContent.includes(${JSON.stringify(needle)})`;
  const button = (label: string) =>
    `[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === ${JSON.stringify(label)})`;
  const click = (selector: string) => evaluate(`(${selector}.click(), true)`);
  const until = async (expression: string) => {
    for (let i = 0; i < 100; i++) {
      // A read is safe to repeat: while the web page's frame reloads, agent-browser may not answer.
      if (await evaluate<boolean>(expression).catch(() => false)) return;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`Timed out waiting for ${expression}`);
  };
  /** A real click, which a dialog's trigger needs to keep its focus (a scripted one is virtual). */
  const press = async (selector: string) => {
    await evaluate(`(${selector}.setAttribute("data-press", ""), true)`);
    await browser("click", "[data-press]");
    await evaluate(`(document.querySelector("[data-press]")?.removeAttribute("data-press"), true)`);
  };
  const pageOf = (id: string, query = "") =>
    `${origin}/en/w/${workspace.slug}/artifacts/${id}${query}`;
  try {
    await experiments.write(workspaceId, "artifacts", true);
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1280", "860");
    const html = (heading: string) =>
      `<!doctype html><html><body style="background:#fff"><h1>${heading}</h1><p>run ${tail}</p></body></html>`;
    const web = await bot.create({
      conversationId: channel.id,
      title: "Signup funnel",
      description: "Signups by day",
      files: { "index.html": html("Signups v1") },
    });
    await bot.push(web.id, 1, { "index.html": html("Signups v2") });

    // The web page: its preview, framed from the sandbox origin.
    await browser("open", pageOf(web.id));
    await browser(
      "wait",
      "--fn",
      `${pageHydrated} && document.querySelector("main iframe") != null`,
    );
    const frame = await evaluate<string>(`document.querySelector("main iframe").src`);
    expect(new URL(frame).host).toBe(`a-${web.id}.${new URL(sandboxOrigin).host}`);
    expect(
      await evaluate<string>(`document.querySelector("main").getAttribute("aria-labelledby")`),
    ).toBeTruthy();
    expect(
      await evaluate<string>(
        `document.getElementById(document.querySelector("main").getAttribute("aria-labelledby")).textContent`,
      ),
    ).toBe("Signup funnel");
    // Its version is on a chip, and a web page is not edited here.
    expect(await chrome.versionChipText()).toBe("v2");
    expect(await evaluate<boolean>(text("Saved"))).toBe(false);
    await shoot("1-web-preview");
    const dark = (on: boolean) =>
      evaluate(`document.documentElement.classList.toggle("dark-mode", ${on}) ?? true`);
    await dark(true);
    await shoot("1-web-preview-dark");
    await browser("set", "viewport", "390", "844");
    await shoot("1-web-preview-phone-dark");
    await dark(false);
    await shoot("1-web-preview-phone");
    await browser("set", "viewport", "1280", "860");

    // The page alone: no Source view and no note over it (Frank, 11-05).
    expect(
      await evaluate<boolean>(
        `[...document.querySelectorAll("main button, main [role=radio]")].some((b) => b.textContent.trim() === "Source")`,
      ),
    ).toBe(false);

    await versionChromeSteps({
      session,
      chrome,
      until,
      shoot,
      publish: () => bot.push(web.id, 2, { "index.html": html("Signups v3") }),
      publisher: agent.displayName,
      frame,
      renameTo: `Signup funnel ${tail}`,
      currentVersion: async () =>
        (await db.artifact.findUniqueOrThrow({ where: { id: web.id } })).currentVersion,
    });

    // Not there, and not the reader's: one page, saying the same.
    await browser("open", pageOf(crypto.randomUUID()));
    await browser("wait", "--fn", `${pageHydrated} && ${text("Can't open this")}`);
    await shoot("3-unavailable");
    // A private channel's document is not the reader's to open: the same page, saying so.
    const secret = await linBot.create({
      conversationId: closed.id,
      title: "Salaries",
      files: { "salaries.md": `Private (run ${tail}).` },
    });
    await browser("open", pageOf(secret.id));
    await browser("wait", "--fn", `${pageHydrated} && ${text("Can't open this")}`);
    expect(await evaluate<boolean>(`document.querySelector("main .ProseMirror") == null`)).toBe(
      true,
    );
    // Moved to the Workspace by its author Agent, whose owner reads it: it opens read only, and
    // the way back is a link to the Workspace, not a button.
    await services.visibility.moveToWorkspace({
      workspaceId,
      artifactId: secret.id,
      agentId: linAgent.id,
    });
    await browser("open", pageOf(secret.id));
    await browser(
      "wait",
      "--fn",
      `${pageHydrated} && document.querySelector('main .ProseMirror[contenteditable="false"]') != null`,
    );
    expect(
      await evaluate<boolean>(
        `[...document.querySelectorAll("main a")].some((a) => a.textContent.includes("Back to the Workspace"))`,
      ),
    ).toBe(true);
    // A member who does not manage its sharing sees no Rename and no Who can see.
    await db.workspaceMembership.updateMany({
      where: { workspaceId, userId: DEV_BROWSER_USER.id },
      data: { role: "member" },
    });
    await browser("open", pageOf(secret.id));
    await browser(
      "wait",
      "--fn",
      `${pageHydrated} && document.querySelector("main .ProseMirror") != null`,
    );
    await chrome.openMore();
    expect(await chrome.moreItems()).not.toContain("Rename");
    expect(await chrome.moreItems()).not.toContain("Who can see");
    expect(await chrome.pillChangeable()).toBe(false);
    await chrome.closeMenus();
    await db.workspaceMembership.updateMany({
      where: { workspaceId, userId: DEV_BROWSER_USER.id },
      data: { role: devRole },
    });
    // A `?doc=` link into that conversation opens the artifact's own page the same way.
    await browser("open", `${origin}/en/w/${workspace.slug}/channel/${closed.id}?doc=${secret.id}`);
    await browser(
      "wait",
      "--fn",
      `location.pathname.endsWith("/artifacts/${secret.id}") && document.querySelector("main .ProseMirror") != null`,
    );

    // An address that names no artifact: the page that is not there, at once.
    await browser("open", pageOf("not-an-id"));
    await browser("wait", "--fn", `${pageHydrated} && ${text("Can't open this")}`);

    // A link from before the page in Activity: the page too.
    await browser("open", `${origin}/en/w/${workspace.slug}/activity?doc=${web.id}`);
    await browser("wait", "--fn", `location.pathname.endsWith("/artifacts/${web.id}")`);

    // Where artifacts are off, a link from before opens the conversation, without the document.
    await experiments.write(workspaceId, "artifacts", false);
    await browser("open", `${origin}/en/w/${workspace.slug}/channel/${channel.id}?doc=${web.id}`);
    await browser(
      "wait",
      "--fn",
      `${pageHydrated} && location.pathname.endsWith("/channel/${channel.id}")`,
    );
    expect(await evaluate<string>("location.search")).not.toContain("doc");
    await experiments.write(workspaceId, "artifacts", true);

    // A web page beside the chat: the Agent's message with its card, and the page itself.
    const chat = `${origin}/en/w/${workspace.slug}/channel/${channel.id}`;
    const sender = await db.conversationMember.findFirstOrThrow({
      where: { conversationId: channel.id, agentId: agent.id },
    });
    await db.message.create({
      data: {
        workspaceId,
        conversationId: channel.id,
        sequence: 1,
        senderMemberId: sender.id,
        body: `The signup funnel is up: ${chat}?doc=${web.id}`,
      },
    });
    await browser("open", `${chat}?doc=${web.id}`);
    await browser(
      "wait",
      "--fn",
      `${pageHydrated} && document.querySelector('section[aria-label="Artifact"] iframe') != null && document.querySelector('article[aria-label="Web page: Signup funnel ${tail}"]') != null`,
    );
    await shoot("7-web-beside-chat");
    await evaluate(`document.documentElement.classList.add("dark-mode") ?? true`);
    await shoot("7-web-beside-chat-dark");
    await browser("set", "viewport", "390", "844");
    await shoot("7-web-beside-chat-phone-dark");
    await evaluate(`document.documentElement.classList.remove("dark-mode") ?? true`);
    await shoot("7-web-beside-chat-phone");
    await browser("set", "viewport", "1280", "860");

    // A document beside the chat: its text, read at the latest version.
    const doc = await bot.create({
      conversationId: channel.id,
      title: "Launch plan",
      files: { "plan.md": `# Goal\n\nShip it (run ${tail}).\n` },
    });
    await bot.push(doc.id, 1, { "plan.md": `# Goal\n\nShip it on Friday (run ${tail}).\n` });
    await browser("open", `${chat}?doc=${doc.id}`);
    await browser(
      "wait",
      "--fn",
      `${pageHydrated} && document.querySelector('section[aria-label="Artifact"] .ProseMirror')?.textContent.includes("Friday")`,
    );
    expect(await evaluate<string>("location.pathname")).toEndWith(`/channel/${channel.id}`);

    // Its own page reads the text, with no editor; a refresh that fails keeps it on show.
    await browser("open", pageOf(doc.id));
    await browser(
      "wait",
      "--fn",
      `${pageHydrated} && document.querySelector("main .ProseMirror")?.textContent.includes("Friday")`,
    );
    expect(
      await evaluate<boolean>(`document.querySelector('main [contenteditable="true"]') == null`),
    ).toBe(true);
    expect(await chrome.versionChipText()).toBe("v2");
    refusing = true;
    // The page reads the document again when its tab comes back (TanStack Query hears
    // `visibilitychange` on window: https://tanstack.com/query/v5/docs/reference/focusManager).
    await evaluate(`(window.dispatchEvent(new Event("visibilitychange")), true)`);
    await new Promise((r) => setTimeout(r, 1000));
    expect(await evaluate<boolean>(text("Can't open this"))).toBe(false);
    expect(await evaluate<boolean>(text("Friday"))).toBe(true);
    await shoot("4-read-failed-kept");
    refusing = false;

    // Deleted while shown: the page that is not there, and leaving it asks nothing.
    await productionArtifacts(db).artifacts.delete({
      workspaceId,
      artifactId: doc.id,
      actor: { agentId: agent.id },
    });
    await evaluate(`(window.dispatchEvent(new Event("visibilitychange")), true)`);
    await browser("wait", "--fn", text("Can't open this"));
    await press(button("Back to the Workspace"));
    await browser("wait", "--fn", `!location.pathname.includes("/artifacts/")`);
    expect(await evaluate<boolean>(`document.querySelector('[role="dialog"]') == null`)).toBe(true);

    // A first read that fails for a moment: said so, and Try again reads it.
    const later = await bot.create({
      conversationId: channel.id,
      title: "Later",
      files: { "later.md": `Later (run ${tail}).` },
    });
    refusingFor = later.id;
    await browser("open", pageOf(later.id));
    await browser("wait", "--fn", pageHydrated);
    await until(text("Couldn't load this"));
    expect(await evaluate<boolean>(text("Can't open this"))).toBe(false);
    await shoot("6-first-read-failed");
    refusingFor = null;
    await click(button("Try again"));
    await browser(
      "wait",
      "--fn",
      `document.querySelector("main .ProseMirror")?.textContent.includes("Later")`,
    );
  } finally {
    refusing = false;
    refusingFor = null;
    await db.workspaceMembership
      .updateMany({ where: { workspaceId, userId: DEV_BROWSER_USER.id }, data: { role: devRole } })
      .catch(() => undefined);
    await browser("close").catch(() => undefined);
    proxy.stop();
    await db.artifact
      .deleteMany({
        where: { homeKey: { in: [`conversation:${channel.id}`, `conversation:${closed.id}`] } },
      })
      .catch(() => undefined);
    await db.conversation
      .deleteMany({ where: { id: { in: [channel.id, closed.id] } } })
      .catch(() => undefined);
    await db.agent
      .deleteMany({ where: { id: { in: [agent.id, linAgent.id] } } })
      .catch(() => undefined);
    await db.workspaceMembership.deleteMany({ where: { userId: lin.id } }).catch(() => undefined);
    await db.user.delete({ where: { id: lin.id } }).catch(() => undefined);
    await experiments.write(workspaceId, "artifacts", before).catch(() => undefined);
    await db.$disconnect();
  }
}, 240_000);
