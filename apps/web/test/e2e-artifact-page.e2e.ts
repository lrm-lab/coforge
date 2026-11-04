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
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";
import { sameOriginProxy } from "./helpers/same-origin-proxy";

/**
 * An artifact's own page beyond editing a document (task #514; editing is
 * `e2e-artifact-documents`): a web page's preview from the sandbox origin, its source, an older
 * version read only with the way back to the latest and no going back to it, Open in new tab on
 * the sandbox's link (and a link that cannot be had, said so), a new version an Agent saves while
 * the page shows; Share greyed as coming soon, and one level for an artifact of the Workspace; one
 * page for an artifact that is not there and one that is not the reader's;
 * a `?doc=` link with a version opening the page at it; and a read that fails while edits are
 * unsaved keeping the editor and the edits, with Try again.
 *
 * Opt-in like the other browser E2Es: real local Web started with the flag file that offers
 * `artifacts` (`/tmp/coforge-flags-docs.json`, read here too), with
 * `COFORGE_ARTIFACT_SANDBOX_ORIGIN` on another host of the same server
 * (`http://localhost:<port>` beside `127.0.0.1`) and a `COFORGE_SESSION_SECRET`, which signs the
 * sandbox's links. Its texts carry the run's tail, since bytes are stored once per Workspace by
 * their hash. Screenshots go under `.amp/e2e/artifact-page/`.
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
  const proxy = sameOriginProxy(webOrigin, centrifugoOrigin, {
    refuse: (url) => refusing && url.pathname.includes("/_serverFn/"),
  });
  const origin = proxy.origin;
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `artifact-page-${process.pid}`);
  const experiments = new PrismaExperimentsRepository(db);
  const { documents } = productionArtifacts(db);
  const { workspaceId, workspace } = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id },
    include: { workspace: { select: { slug: true } } },
  });
  const before = (await experiments.read(workspaceId)).artifacts;
  const tail = `${process.pid}-${Date.now()}`.slice(-6);
  const agent = await db.agent.findFirstOrThrow({
    where: { workspaceId, deletedAt: null, visibility: "public", weeklyReportAssistant: null },
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
  // Lin's private channel, which the viewer is not in.
  const closed = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `e2e-closed-${tail}`,
      description: "",
      visibility: "private",
      members: { create: [{ userId: lin.id }] },
    },
  });
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
    const bot = { workspaceId, actor: { agentId: agent.id } };
    const html = (heading: string) =>
      `<!doctype html><html><body style="background:#fff"><h1>${heading}</h1><p>run ${tail}</p></body></html>`;
    const web = await documents.create(bot, {
      conversationId: channel.id,
      kind: "html",
      title: "Signup funnel",
      description: "Signups by day",
      text: html("Signups v1"),
    });
    await documents.save(bot, {
      artifactId: web.id,
      baseVersion: 1,
      idempotencyKey: crypto.randomUUID(),
      text: html("Signups v2"),
    });

    // The web page: its preview, framed from the sandbox origin.
    await browser("open", pageOf(web.id));
    await browser(
      "wait",
      "--fn",
      `${pageHydrated} && document.querySelector("main iframe") != null`,
    );
    const frame = await evaluate<string>(`document.querySelector("main iframe").src`);
    expect(new URL(frame).origin).toBe(new URL(sandboxOrigin).origin);
    expect(
      await evaluate<string>(`document.querySelector("main").getAttribute("aria-labelledby")`),
    ).toBeTruthy();
    expect(
      await evaluate<string>(
        `document.getElementById(document.querySelector("main").getAttribute("aria-labelledby")).textContent`,
      ),
    ).toBe("Signup funnel");
    await shoot("1-web-preview");

    // Its source.
    await click(
      `[...document.querySelectorAll('[role="radio"], button')].find((b) => b.textContent.trim() === "Source")`,
    );
    await browser(
      "wait",
      "--fn",
      `document.querySelector("main pre")?.textContent.includes("Signups v2")`,
    );

    // Version 1: read only, the way back to the latest, and no going back to it.
    await browser("open", pageOf(web.id, "?version=1"));
    await browser("wait", "--fn", `${pageHydrated} && ${text("Viewing version 1")}`);
    expect(await evaluate<boolean>(`${button("Back to latest")} != null`)).toBe(true);
    expect(await evaluate<boolean>(`${button("Go back to this version")} == null`)).toBe(true);
    await click(
      `[...document.querySelectorAll('[role="radio"], button')].find((b) => b.textContent.trim() === "Source")`,
    );
    await browser(
      "wait",
      "--fn",
      `document.querySelector("main pre")?.textContent.includes("Signups v1")`,
    );
    await shoot("2-web-old-version");
    await click(button("Back to latest"));
    await browser("wait", "--fn", `!new URLSearchParams(location.search).has("version")`);

    // The Agent saves version 3 while the page shows: it says who, and shows it.
    await documents.save(bot, {
      artifactId: web.id,
      baseVersion: 2,
      idempotencyKey: crypto.randomUUID(),
      text: html("Signups v3"),
    });
    await browser("wait", "--fn", text("published version 3"));
    await shoot("2b-web-new-version");

    // Open in new tab: the sandbox's link, in a tab cut off from this one.
    await press(`document.querySelector('main header button[aria-label="More actions"]')`);
    const openItem = `[...document.querySelectorAll('[role="menuitem"]')].find((i) => i.textContent.includes("Open in new tab"))`;
    await browser("wait", "--fn", `${openItem} != null`);
    await click(openItem);
    let tabs = "";
    for (let i = 0; i < 50 && !tabs.includes(new URL(sandboxOrigin).host); i++) {
      await new Promise((r) => setTimeout(r, 100));
      tabs = await browser("tab", "list");
    }
    expect(tabs).toContain(new URL(sandboxOrigin).host);
    // Back to the app's tab: the first one, whose id is the session's first (`t1`).
    const appTab = /\b(t\d+)\b[^\n]*127\.0\.0\.1/.exec(tabs)?.[1];
    expect(appTab).toBeDefined();
    await browser("tab", appTab!);

    // A link that cannot be had: the tab closes, and the page says so.
    refusing = true;
    await press(`document.querySelector('main header button[aria-label="More actions"]')`);
    await browser("wait", "--fn", `${openItem} != null`);
    await click(openItem);
    await browser("wait", "--fn", text("Couldn't open the page in a new tab"));
    refusing = false;

    // Share, before who can see it is stored (task #529): the levels greyed, as coming soon.
    await press(
      `[...document.querySelectorAll("main header button")].find((b) => b.textContent.trim() === "Share")`,
    );
    const radios = `[...document.querySelectorAll('[role="dialog"] input[type="radio"]')]`;
    await browser("wait", "--fn", `${radios}.length === 2`);
    expect(await evaluate<boolean>(`${radios}.every((radio) => radio.disabled)`)).toBe(true);
    const group = `document.querySelector('[role="dialog"] [role="radiogroup"]')`;
    expect(
      await evaluate<string>(
        `document.getElementById(${group}.getAttribute("aria-describedby")).textContent`,
      ),
    ).toContain("coming soon");
    await shoot("2c-share-soon");
    await browser("press", "Escape");
    await browser("wait", "--fn", `document.querySelector('[role="dialog"]') == null`);

    // Not there, and not the reader's: one page, saying the same.
    await browser("open", pageOf(crypto.randomUUID()));
    await browser("wait", "--fn", `${pageHydrated} && ${text("Can't open this")}`);
    const missing = await evaluate<string>(`document.querySelector("main").textContent`);
    await shoot("3-unavailable");
    const secret = await documents.create(
      { workspaceId, actor: { userId: lin.id } },
      { conversationId: closed.id, title: "Salaries", text: `Private (run ${tail}).` },
    );
    await browser("open", pageOf(secret.id));
    await browser("wait", "--fn", `${pageHydrated} && ${text("Can't open this")}`);
    expect(await evaluate<string>(`document.querySelector("main").textContent`)).toBe(missing);
    expect(await evaluate<boolean>(`${button("Back to the Workspace")} != null`)).toBe(true);

    // An artifact of the Workspace itself: one level, everyone in it; the way back is the Workspace.
    const notes = await documents.create(
      { workspaceId, actor: { userId: DEV_BROWSER_USER.id } },
      { title: "Workspace notes", text: `Notes (run ${tail}).` },
    );
    await browser("open", pageOf(notes.id));
    await browser(
      "wait",
      "--fn",
      `${pageHydrated} && document.querySelector("main .ProseMirror") != null`,
    );
    expect(
      await evaluate<string>(`document.querySelector("main header a").getAttribute("href")`),
    ).toEndWith(`/w/${workspace.slug}`);
    await press(
      `[...document.querySelectorAll("main header button")].find((b) => b.textContent.trim() === "Share")`,
    );
    await browser("wait", "--fn", `${radios}.length === 1`);
    expect(
      await evaluate<string>(
        `document.querySelector('[role="dialog"] [role="radiogroup"]').textContent`,
      ),
    ).toContain("Everyone in the Workspace");
    await browser("press", "Escape");

    // A link from before the page, with a version: the page at that version.
    const doc = await documents.create(bot, {
      conversationId: channel.id,
      title: "Launch plan",
      text: `# Goal\n\nShip it (run ${tail}).\n`,
    });
    await documents.save(bot, {
      artifactId: doc.id,
      baseVersion: 1,
      idempotencyKey: crypto.randomUUID(),
      text: `# Goal\n\nShip it on Friday (run ${tail}).\n`,
    });
    await browser(
      "open",
      `${origin}/en/w/${workspace.slug}/channel/${channel.id}?doc=${doc.id}&docVersion=1&docHistory=true`,
    );
    await browser("wait", "--fn", `location.pathname.endsWith("/artifacts/${doc.id}")`);
    const params = await evaluate<string>("location.search");
    expect(new URLSearchParams(params).get("version")).toBe("1");
    expect(new URLSearchParams(params).get("history")).toBe("true");
    await browser("wait", "--fn", `${pageHydrated} && ${text("Viewing version 1")}`);

    // A read that fails while edits are unsaved: the editor and the edits stay, with Try again.
    await browser("open", pageOf(doc.id));
    await browser(
      "wait",
      "--fn",
      `${pageHydrated} && document.querySelector("main .ProseMirror") != null`,
    );
    await evaluate(`(() => {
      const editor = document.querySelector("main .ProseMirror");
      editor.focus();
      const range = document.createRange();
      range.selectNodeContents(editor.lastElementChild);
      range.collapse(false);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      return true;
    })()`);
    await browser("keyboard", "type", " Unsaved line.");
    await browser("wait", "--fn", text("Unsaved changes"));
    refusing = true;
    // The page reads the document again when its tab comes back (TanStack Query hears
    // `visibilitychange` on window: https://tanstack.com/query/v5/docs/reference/focusManager).
    await evaluate(`(window.dispatchEvent(new Event("visibilitychange")), true)`);
    await browser("wait", "--fn", text("Couldn't check for changes"));
    expect(
      await evaluate<string>(`document.querySelector("main .ProseMirror").textContent`),
    ).toContain("Unsaved line.");
    expect(await evaluate<boolean>(text("Can't open this"))).toBe(false);
    await shoot("4-read-failed-unsaved");
    refusing = false;
    await click(button("Try again"));
    await browser("wait", "--fn", `!${text("Couldn't check for changes")}`);
    expect(
      await evaluate<string>(`document.querySelector("main .ProseMirror").textContent`),
    ).toContain("Unsaved line.");
  } finally {
    refusing = false;
    await browser("close").catch(() => undefined);
    proxy.stop();
    await db.artifact
      .deleteMany({
        where: {
          OR: [
            { homeKey: { in: [`conversation:${channel.id}`, `conversation:${closed.id}`] } },
            { workspaceId, title: "Workspace notes", preview: { contains: tail } },
          ],
        },
      })
      .catch(() => undefined);
    await db.conversation
      .deleteMany({ where: { id: { in: [channel.id, closed.id] } } })
      .catch(() => undefined);
    await db.workspaceMembership.deleteMany({ where: { userId: lin.id } }).catch(() => undefined);
    await db.user.delete({ where: { id: lin.id } }).catch(() => undefined);
    await experiments.write(workspaceId, "artifacts", before).catch(() => undefined);
    await db.$disconnect();
  }
}, 240_000);
