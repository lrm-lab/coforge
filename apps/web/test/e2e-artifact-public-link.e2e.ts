import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { productionArtifacts } from "#src/server/artifacts/artifact-composition.server";
import { PrismaExperimentsRepository } from "#src/server/experiments/experiments.repositories.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";

/**
 * A public link from an artifact's Share (task #646): the switch beside the two levels, the link
 * it gives opening with no session, the level untouched, and off killing that link, for a
 * document and a web page; a kind with no public link shows no switch.
 *
 * Opt-in like `e2e-artifact-page`: real local Web with `COFORGE_ARTIFACT_SANDBOX_ORIGIN` on
 * another host of the same server and a `COFORGE_SESSION_SECRET`. Screenshots go under
 * `.amp/e2e/artifact-public-link/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/artifact-public-link");

test("an artifact's Share: a public link on and off", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `artifact-link-${process.pid}`);
  const experiments = new PrismaExperimentsRepository(db);
  const { documents } = productionArtifacts(db);
  const { workspaceId, workspace } = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id, role: "owner" },
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
  const until = async (expression: string) => {
    for (let i = 0; i < 100; i++) {
      if (await evaluate<boolean>(expression)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`Timed out waiting for ${expression}`);
  };
  const press = async (selector: string) => {
    await evaluate(`(${selector}.setAttribute("data-press", ""), true)`);
    await browser("click", "[data-press]");
    await evaluate(`(document.querySelector("[data-press]")?.removeAttribute("data-press"), true)`);
  };
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
  const share = `[...document.querySelectorAll("main header button")].find((b) => b.textContent.trim() === "Share" || b.getAttribute("aria-label") === "Share")`;
  const toggle = `document.querySelector('[role="dialog"] input[role="switch"]')`;
  const switchLabel = `${toggle}?.closest("label")`;
  const linkText = `[...document.querySelectorAll('[role="dialog"] p')].find((p) => p.textContent.includes("/p/"))?.textContent`;
  const pageOf = (id: string) => `${origin}/en/w/${workspace.slug}/artifacts/${id}`;
  const close = () =>
    press(
      `[...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.trim() === "Done")`,
    );
  const openShare = async (id: string) => {
    await browser("open", pageOf(id));
    await until(`${pageHydrated} && ${share} != null`);
    await press(share);
    await until(`document.querySelectorAll('[role="dialog"] input[type="radio"]').length === 2`);
  };
  /** Turns the link on and off from the open dialog, proving the link serves and then dies. */
  const roundTrip = async (id: string, shot?: string) => {
    await until(`${toggle} != null`);
    if (shot) await shots(`${shot}-off`);
    await press(switchLabel);
    await until(`${linkText} != null`);
    if (shot) await shots(`${shot}-on`);
    const url = await evaluate<string>(linkText);
    const open = await fetch(url);
    expect(open.status).toBe(200);
    expect(open.headers.get("set-cookie")).toBeNull();
    expect(await open.text()).toContain("/page");
    expect((await db.artifact.findUniqueOrThrow({ where: { id } })).access).toBe("conversation");
    expect(
      await evaluate<boolean>(
        `document.querySelector('[role="dialog"] input[type="radio"]:checked')?.value === "conversation"`,
      ),
    ).toBe(true);
    if (shot) {
      await browser("open", url);
      await browser("wait", "1500"); // Its frame is on another origin: no reads across it.
      await browser("screenshot", join(artifacts, `${shot}-public-page.png`));
    }
    // Read back after a reload: the page knows the link, and Share shows it.
    await openShare(id);
    await until(`${linkText} === ${JSON.stringify(url)}`);
    await press(switchLabel);
    await until(`${linkText} == null && !${toggle}.disabled`);
    expect((await fetch(url)).status).toBe(404);
    return url;
  };
  try {
    await experiments.write(workspaceId, "artifacts", true);
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1280", "860");
    const viewer = { workspaceId, actor: { userId: DEV_BROWSER_USER.id } };
    const doc = await documents.create(viewer, {
      conversationId: channel.id,
      title: "Launch plan",
      text: `Launch plan body ${tail}.`,
    });
    const web = await documents.create(
      { workspaceId, actor: { agentId: agent.id } },
      {
        conversationId: channel.id,
        kind: "html",
        title: "Signup funnel",
        description: "Signups by day",
        text: `<!doctype html><html><body><h1>Signups ${tail}</h1></body></html>`,
      },
    );

    await openShare(doc.id);
    const first = await roundTrip(doc.id, "desktop");
    // On again: a new link, never the old one.
    await press(switchLabel);
    await until(`${linkText} != null`);
    expect(await evaluate<string>(linkText)).not.toBe(first);
    await press(switchLabel);
    await until(`${linkText} == null && !${toggle}.disabled`);
    await close();

    await openShare(web.id);
    await roundTrip(web.id, "web");
    await close();

    // A phone: the link wraps inside the dialog, never past it.
    await browser("set", "viewport", "390", "844");
    await openShare(doc.id);
    await until(`${toggle} != null`);
    await press(switchLabel);
    await until(`${linkText} != null`);
    await shots("phone-on");
    expect(
      await evaluate<boolean>(
        `(() => { const d = document.querySelector('[role="dialog"]'); return d.scrollWidth <= d.clientWidth; })()`,
      ),
    ).toBe(true);
    await press(switchLabel);
    await until(`${linkText} == null`);
  } finally {
    await browser("close").catch(() => undefined);
    await db.artifact
      .deleteMany({ where: { homeKey: `conversation:${channel.id}` } })
      .catch(() => undefined);
    await db.conversation.delete({ where: { id: channel.id } }).catch(() => undefined);
    await db.agent.delete({ where: { id: agent.id } }).catch(() => undefined);
    await experiments.write(workspaceId, "artifacts", before).catch(() => undefined);
    await db.$disconnect();
  }
}, 180_000);
