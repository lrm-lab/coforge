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

const { origin, browserPath, databaseUrl } = localBrowserE2e();
const sandboxOrigin = Bun.env.COFORGE_ARTIFACT_SANDBOX_ORIGIN;
if (!sandboxOrigin) throw new Error("COFORGE_ARTIFACT_SANDBOX_ORIGIN is required");
const artifacts = join(import.meta.dir, "../../../.artifacts/e2e/artifact-public-link");

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
    include: { workspace: { select: { slug: true, name: true } } },
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
    await browser("wait", "300");
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
  const copiedLink = async () => {
    await evaluate(
      `(navigator.clipboard.writeText = async (text) => { window.__copiedLink = text; }, window.__copiedLink = null, true)`,
    );
    await browser("find", "role", "button", "click", "--name", "Copy link");
    await chrome.until(`typeof window.__copiedLink === "string"`);
    return evaluate<string>(`window.__copiedLink`);
  };
  const turnOff = async () => {
    await chrome.chooseFromPill(`Everyone in ${workspace.name}`);
    await chrome.until(`document.body.textContent.includes("Turn off link sharing?")`);
    expect(await chrome.dialogText()).toContain("The public link will stop working.");
    await chrome.confirmDialog("Turn off link sharing");
    await chrome.untilPillScope(`Everyone in ${workspace.name}`);
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

    await browser("open", pageOf(doc.id));
    await browser("wait", "--fn", artifactChromeReady);
    expect(await copiedLink()).toBe(pageOf(doc.id));
    const docUrl = await turnOn(doc.id);
    expect(await copiedLink()).toBe(docUrl);
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
    expect(await copiedLink()).toBe(pageOf(doc.id));
    await visitor.browser("open", docUrl);
    expect(
      await visitor.evaluate<boolean>(
        `document.body.textContent.includes("We open signups on Monday")`,
      ),
    ).toBe(false);
    await shots("doc-off");

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

    const roster = await bot.create({
      conversationId: channel.id,
      title: "Roster",
      files: { "team.csv": `name,team\nNoor ${tail},Growth\nAmir,<Ops>\n` },
    });
    const rosterUrl = await turnOn(roster.id);
    expect((await fetch(rosterUrl, { redirect: "manual" })).headers.get("location")).toContain(
      "/file/team.csv",
    );
    await visit(rosterUrl, `Noor ${tail}`);
    expect(
      await visitor.evaluate<string[]>(
        `[...document.querySelectorAll("th")].map((th) => th.textContent)`,
      ),
    ).toEqual(["name", "team"]);
    expect(await visitor.evaluate<boolean>(`document.body.textContent.includes("<Ops>")`)).toBe(
      true,
    );
    await turnOff();

    const logo = await bot.create({
      conversationId: channel.id,
      title: `Logo ${tail}`,
      files: {
        "brand/logo.svg":
          '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120"><rect width="240" height="120" rx="16" fill="#2f6f5e"/></svg>',
      },
    });
    const logoUrl = await turnOn(logo.id);
    await visit(logoUrl, `Logo ${tail}`);
    await visitor.browser(
      "wait",
      "--fn",
      `(() => { const img = document.querySelector("figure img"); return !!img && img.complete && img.naturalWidth === 240; })()`,
    );
    await visitor.browser("screenshot", join(artifacts, "visitor-image.png"));
    await turnOff();

    const paper = await bot.create({
      conversationId: channel.id,
      title: `Paper ${tail}`,
      files: { "paper.pdf": "%PDF-1.4\n%%EOF\n" },
    });
    const paperUrl = await turnOn(paper.id);
    await visit(paperUrl, "Sign in to CoForge to view this file");
    await turnOff();
    await gone(paperUrl);

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
