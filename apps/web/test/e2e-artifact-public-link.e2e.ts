import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { productionArtifacts } from "#src/server/artifacts/artifact-composition.server";
import { agentWrites } from "./helpers/artifact-agent-writes";
import { PrismaExperimentsRepository } from "#src/server/experiments/experiments.repositories.server";
import { artifactPageOrigin } from "#src/server/artifacts/artifact-sandbox-config.server";
import { artifactChrome, artifactChromeReady } from "./helpers/artifact-chrome";
import { browserSession, localBrowserE2e } from "./helpers/browser-e2e";

/**
 * Anyone with the link, from the who-can-see pill (task #646): choosing it asks first, the link
 * it gives opens with no session and serves the page's own content, and choosing a narrower level
 * asks again and ends that link, for a document and a web page. The link is read from the
 * database, since the page never shows it; a signed-out visitor is a browser session of its own.
 * What a web page shows inside its frame is on another origin, so its content is read from the
 * response the visitor gets.
 *
 * Opt-in like `e2e-artifact-page`: real local Web with `COFORGE_ARTIFACT_SANDBOX_ORIGIN` on
 * another host of the same server and a `COFORGE_SESSION_SECRET`. Screenshots go under
 * `.amp/e2e/artifact-public-link/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const sandboxOrigin = Bun.env.COFORGE_ARTIFACT_SANDBOX_ORIGIN;
if (!sandboxOrigin) throw new Error("COFORGE_ARTIFACT_SANDBOX_ORIGIN is required");
const artifacts = join(import.meta.dir, "../../../.amp/e2e/artifact-public-link");

test("an artifact's public link: turned on from the pill, served to a visitor, turned off", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const session = browserSession(browserPath, `artifact-link-${process.pid}`);
  const { browser, evaluate } = session;
  const chrome = artifactChrome(session);
  const visitor = browserSession(browserPath, `artifact-link-visitor-${process.pid}`);
  const experiments = new PrismaExperimentsRepository(db);
  const services = productionArtifacts(db);
  const { workspaceId, workspace } = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id, role: "owner" },
    orderBy: { createdAt: "asc" },
    include: { workspace: { select: { slug: true } } },
  });
  const before = (await experiments.read(workspaceId)).artifacts;
  const tail = `${process.pid}-${Date.now()}`.slice(-6);
  const agent = await db.agent.create({
    data: {
      workspaceId,
      name: `e2e-public-link-${tail}`,
      displayName: "Public link",
      ownerId: DEV_BROWSER_USER.id,
      runtimeConfig: {},
    },
  });
  const channel = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `e2e-public-link-${tail}`,
      description: "",
      members: { create: [{ userId: DEV_BROWSER_USER.id }, { agentId: agent.id }] },
    },
  });
  const settled = () =>
    browser("wait", "--fn", `document.getAnimations().every((a) => a.playState !== "running")`);
  const shots = async (name: string) => {
    await settled();
    await browser("screenshot", join(artifacts, `${name}.png`));
    await evaluate(`(document.documentElement.classList.add("dark-mode"), true)`);
    await browser("wait", "300"); // Controls ease between themes.
    await settled();
    await browser("screenshot", join(artifacts, `${name}-dark.png`));
    await evaluate(`(document.documentElement.classList.remove("dark-mode"), true)`);
    await browser("wait", "300");
  };
  const pageOf = (id: string) => `${origin}/en/w/${workspace.slug}/artifacts/${id}`;
  const liveLink = async (id: string) => {
    const live = await db.artifactPublicLink.findFirst({
      where: { artifactId: id, revokedAt: null },
      select: { token: true },
    });
    return live ? `${artifactPageOrigin(sandboxOrigin, id)}/p/${live.token}` : null;
  };
  const turnOn = async (id: string) => {
    await browser("open", pageOf(id));
    await browser("wait", "--fn", artifactChromeReady);
    await chrome.chooseFromPill("Anyone with the link");
    await chrome.until(`document.body.textContent.includes("Turn on link sharing?")`);
    expect(await chrome.dialogText()).toContain(
      "Anyone with the link can open it without signing in.",
    );
    await shots("link-on-confirm");
    expect(await liveLink(id)).toBeNull();
    await chrome.confirmDialog("Turn on link sharing");
    await chrome.untilPillScope("Anyone with the link");
    const url = await liveLink(id);
    expect(url).not.toBeNull();
    return url!;
  };
  const turnOff = async () => {
    await chrome.chooseFromPill("Everyone in the Workspace");
    await chrome.until(`document.body.textContent.includes("Turn off link sharing?")`);
    expect(await chrome.dialogText()).toContain("The public link will stop working.");
    await chrome.confirmDialog("Turn off link sharing");
    await chrome.untilPillScope("Everyone in the Workspace");
  };
  try {
    await experiments.write(workspaceId, "artifacts", true);
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1280", "860");
    const bot = agentWrites(services, workspaceId, agent.id);
    const doc = await bot.create({
      conversationId: channel.id,
      title: "Launch plan",
      files: {
        "plan.md": [
          `We open signups on Monday (run ${tail}).`,
          "## What ships",
          "- The invite flow, with **two seats** free\n- A public changelog",
          "## Dates",
          "| Step | Owner | When |\n| --- | --- | --- |\n| Freeze | Noor | Friday |\n| Open | Amir | Monday |",
          "> Roll back if signups fail for ten minutes.",
        ].join("\n\n"),
      },
    });
    const web = await bot.create({
      conversationId: channel.id,
      title: "Signup funnel",
      description: "Signups by day",
      files: { "index.html": `<!doctype html><html><body><h1>Signups ${tail}</h1></body></html>` },
    });

    const visit = async (url: string, content: string) => {
      await visitor.browser("open", url);
      await visitor.browser(
        "wait",
        "--fn",
        `document.body.textContent.includes(${JSON.stringify(content)})`,
        "--timeout",
        "20000",
      );
      await visitor.browser(
        "screenshot",
        join(artifacts, `visitor-${content.slice(0, 8).trim()}.png`),
      );
    };
    const gone = async (url: string) => {
      expect((await fetch(url, { redirect: "manual" })).status).toBe(404);
    };

    const docUrl = await turnOn(doc.id);
    const served = await fetch(docUrl, { redirect: "manual" });
    expect(served.status).toBe(302);
    expect(served.headers.get("set-cookie")).toBeNull();
    expect(served.headers.get("location")).toContain("/page/");
    await shots("doc-on");
    await visit(docUrl, `We open signups on Monday (run ${tail}).`);
    expect(
      await visitor.evaluate<boolean>(
        `document.body.textContent.includes("Roll back if signups fail")`,
      ),
    ).toBe(true);
    await turnOff();
    await gone(docUrl);
    expect(await liveLink(doc.id)).toBeNull();
    await visitor.browser("open", docUrl);
    expect(
      await visitor.evaluate<boolean>(
        `document.body.textContent.includes("We open signups on Monday")`,
      ),
    ).toBe(false);
    await shots("doc-off");

    // On again: a new link, never the old one.
    const again = await turnOn(doc.id);
    expect(again).not.toBe(docUrl);
    await gone(docUrl);
    await turnOff();
    await gone(again);

    const webUrl = await turnOn(web.id);
    await visit(webUrl, `Signups ${tail}`);
    await shots("web-on");
    await turnOff();
    await gone(webUrl);

    // A phone: the confirmation fits the screen.
    await browser("set", "viewport", "390", "844");
    await browser("open", pageOf(doc.id));
    await browser("wait", "--fn", artifactChromeReady);
    await chrome.chooseFromPill("Anyone with the link");
    await chrome.until(`document.body.textContent.includes("Turn on link sharing?")`);
    await shots("phone-confirm");
    expect(
      await evaluate<boolean>(
        `(() => { const d = [...document.querySelectorAll('[role="alertdialog"], [role="dialog"]')].at(-1); return d.scrollWidth <= d.clientWidth; })()`,
      ),
    ).toBe(true);
    await chrome.confirmDialog("Turn on link sharing");
    await chrome.untilPillScope("Anyone with the link");
    await turnOff();
  } finally {
    await browser("close").catch(() => undefined);
    await visitor.browser("close").catch(() => undefined);
    await db.artifact
      .deleteMany({ where: { homeKey: `conversation:${channel.id}` } })
      .catch(() => undefined);
    await db.conversation.delete({ where: { id: channel.id } }).catch(() => undefined);
    await db.agent.delete({ where: { id: agent.id } }).catch(() => undefined);
    await experiments.write(workspaceId, "artifacts", before).catch(() => undefined);
    await db.$disconnect();
  }
}, 180_000);
