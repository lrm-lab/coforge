import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { productionArtifacts } from "#src/server/artifacts/artifact-composition.server";
import { agentWrites } from "./helpers/artifact-agent-writes";
import { artifactChrome, artifactViewerReady } from "./helpers/artifact-chrome";
import {
  animationsSettled,
  browserSession,
  devBrowserWorkspace,
  localBrowserE2e,
  pageHydrated,
} from "./helpers/browser-e2e";

const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.artifacts/e2e/artifact-share");

test("an artifact's who-can-see: the home, the Workspace, and who loses access", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const session = browserSession(browserPath, `artifact-share-${process.pid}`);
  const { browser, evaluate } = session;
  const chrome = artifactChrome(session);
  const services = productionArtifacts(db);
  const { workspaceId, workspace } = await devBrowserWorkspace(db);
  const workspaceName = (
    await db.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { name: true } })
  ).name;
  const everyone = `Everyone in ${workspaceName}`;
  const tail = `${process.pid}-${Date.now()}`.slice(-6);
  const agent = await db.agent.create({
    data: {
      workspaceId,
      name: `e2e-share-${tail}`,
      displayName: "Share",
      ownerId: DEV_BROWSER_USER.id,
      runtimeConfig: {},
    },
  });
  const channel = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `e2e-share-${tail}`,
      description: "",
      visibility: "private",
      members: { create: [{ userId: DEV_BROWSER_USER.id }, { agentId: agent.id }] },
    },
  });
  const lin = await db.user.create({ data: { username: `lin-${tail}`, displayName: "Lin Xia" } });
  await db.workspaceMembership.create({ data: { workspaceId, userId: lin.id, role: "member" } });
  const linAgent = await db.agent.create({
    data: {
      workspaceId,
      name: `e2e-share-lin-bot-${tail}`,
      displayName: "Lin's bot",
      ownerId: lin.id,
      runtimeConfig: {},
    },
  });
  const closed = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `e2e-share-closed-${tail}`,
      description: "",
      visibility: "private",
      members: { create: [{ userId: lin.id }, { agentId: linAgent.id }] },
    },
  });
  const noor = await db.user.create({
    data: { username: `noor-${tail}`, displayName: "Noor Haddad" },
  });
  const other = await db.workspace.create({
    data: {
      name: "Share as a member",
      slug: `e2e-share-member-${tail}`,
      members: {
        create: [
          { userId: noor.id, role: "owner" },
          { userId: DEV_BROWSER_USER.id, role: "member" },
        ],
      },
    },
  });
  const settled = () => browser("wait", "--fn", animationsSettled());
  const shoot = async (shot: string) => {
    await settled();
    await browser("screenshot", join(artifacts, `${shot}.png`));
  };
  const viewer = artifactViewerReady;
  const text = (needle: string) => `document.body.textContent.includes(${JSON.stringify(needle)})`;
  const pageOf = (id: string) => `${origin}/en/w/${workspace.slug}/artifacts/${id}`;
  try {
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1280", "860");
    const bot = agentWrites(services, workspaceId, agent.id);
    const linBot = agentWrites(services, workspaceId, linAgent.id);
    const plan = await bot.create({
      conversationId: channel.id,
      title: "Launch plan",
      files: { "plan.md": `Plan (run ${tail}).` },
    });

    await browser("open", pageOf(plan.id));
    await browser("wait", "--fn", viewer);
    expect(await chrome.versionChipText()).toBe("v1");
    expect(
      await evaluate<string>(`document.querySelector("main header a").getAttribute("href")`),
    ).toEndWith(`/channel/${channel.id}`);
    await chrome.untilPillScope(`#e2e-share-${tail}`);
    expect(await chrome.pillChangeable()).toBe(true);
    await chrome.press(`document.querySelector('main header button[aria-label^="Who can see:"]')`);
    await chrome.until(`document.querySelector('[role="menuitemradio"]') != null`);
    expect(await chrome.selectedScope()).toBe(`#e2e-share-${tail}`);
    expect(
      await evaluate<string[]>(
        `[...document.querySelectorAll('[role="menuitemradio"]')].map((i) => i.textContent.trim())`,
      ),
    ).toEqual([`#e2e-share-${tail}`, everyone, "Anyone with the link"]);
    await shoot("1-pill-menu");
    await chrome.closeMenus();

    await chrome.chooseFromPill(everyone);
    await chrome.untilPillScope(everyone);
    expect((await db.artifact.findUniqueOrThrow({ where: { id: plan.id } })).access).toBe(
      "workspace",
    );
    await shoot("2-widened");

    await chrome.chooseFromMore(`#e2e-share-${tail}`);
    await chrome.until(
      `/(\\d+ (person|people)) and (\\d+ Agents?) will lose access/.test(document.body.textContent)`,
    );
    const loss = /(\d+) (person|people) and (\d+) (Agent|Agents) will lose access\./.exec(
      await chrome.dialogText(),
    );
    expect(loss).not.toBeNull();
    expect(Number(loss?.[1])).toBeGreaterThanOrEqual(1);
    expect(loss?.[2]).toBe(loss?.[1] === "1" ? "person" : "people");
    expect(loss?.[4]).toBe(loss?.[3] === "1" ? "Agent" : "Agents");
    expect(await chrome.dialogText()).toContain(`Move to #e2e-share-${tail}?`);
    expect(
      await evaluate<string | null>(
        `[...document.querySelectorAll('[role="alertdialog"], [role="dialog"]')].at(-1)?.querySelector("button[data-tone]")?.dataset.tone ?? null`,
      ),
    ).toBe("warning");
    await shoot("3-narrowing");
    expect((await db.artifact.findUniqueOrThrow({ where: { id: plan.id } })).access).toBe(
      "workspace",
    );
    await chrome.confirmDialog("Move to that conversation");
    await chrome.untilPillScope(`#e2e-share-${tail}`);
    expect((await db.artifact.findUniqueOrThrow({ where: { id: plan.id } })).access).not.toBe(
      "workspace",
    );

    const leads = await linBot.create({
      conversationId: closed.id,
      title: "Leads",
      files: { "leads.md": `Leads (run ${tail}).` },
    });
    await browser("open", pageOf(leads.id));
    await browser("wait", "--fn", `${pageHydrated} && ${text("Can't open this")}`);
    expect(await evaluate<boolean>(`document.querySelector("main .ProseMirror") == null`)).toBe(
      true,
    );
    await shoot("2b-closed-home-unavailable");

    await services.visibility.moveToWorkspace({
      workspaceId,
      artifactId: leads.id,
      agentId: linAgent.id,
    });
    await browser("open", pageOf(leads.id));
    await browser("wait", "--fn", viewer);
    expect(
      await evaluate<string>(`document.querySelector("main header a").getAttribute("href")`),
    ).toEndWith(`/w/${workspace.slug}`);
    expect(await evaluate<string>(`document.querySelector("main header a").textContent`)).toBe(
      "Back to the Workspace",
    );
    await chrome.untilPillScope(everyone);
    await shoot("4-workspace-read");
    await chrome.press(`document.querySelector('main header button[aria-label^="Who can see:"]')`);
    await chrome.until(`document.querySelector('[role="menuitemradio"]') != null`);
    expect(
      await evaluate<string[]>(
        `[...document.querySelectorAll('[role="menuitemradio"]')].map((i) => i.textContent.trim())`,
      ),
    ).toEqual([everyone, "Anyone with the link"]);
    await chrome.closeMenus();

    const noorChannel = await db.conversation.create({
      data: {
        workspaceId: other.id,
        channelName: `e2e-share-noor-${tail}`,
        description: "",
        members: { create: [{ userId: noor.id }, { userId: DEV_BROWSER_USER.id }] },
      },
    });
    const noorAgent = await db.agent.create({
      data: {
        workspaceId: other.id,
        name: `e2e-share-noor-bot-${tail}`,
        displayName: "Noor's bot",
        ownerId: noor.id,
        runtimeConfig: {},
      },
    });
    await db.conversationMember.create({
      data: { conversationId: noorChannel.id, workspaceId: other.id, agentId: noorAgent.id },
    });
    const brief = await agentWrites(services, other.id, noorAgent.id).create({
      conversationId: noorChannel.id,
      title: "Brief",
      files: { "brief.md": `Brief (run ${tail}).` },
    });
    await browser("open", `${origin}/en/w/${other.slug}/artifacts/${brief.id}`);
    await browser("wait", "--fn", viewer);
    await chrome.untilPillScope(`#e2e-share-noor-${tail}`);
    expect(await chrome.pillChangeable()).toBe(false);
    await chrome.openMore();
    const items = await chrome.moreItems();
    expect(items).toContain("Send to…");
    expect(items).not.toContain("Who can see");
    expect(items).not.toContain("Rename");
    await shoot("5-member-chrome");
    await chrome.closeMenus();
  } finally {
    await browser("close").catch(() => undefined);
    await db.artifact
      .deleteMany({
        where: { homeKey: { in: [`conversation:${channel.id}`, `conversation:${closed.id}`] } },
      })
      .catch(() => undefined);
    await db.conversation
      .deleteMany({ where: { id: { in: [channel.id, closed.id] } } })
      .catch(() => undefined);
    await db.artifact.deleteMany({ where: { workspaceId: other.id } }).catch(() => undefined);
    await db.conversation.deleteMany({ where: { workspaceId: other.id } }).catch(() => undefined);
    await db.workspace.delete({ where: { id: other.id } }).catch(() => undefined);
    await db.user.delete({ where: { id: noor.id } }).catch(() => undefined);
    await db.agent
      .deleteMany({ where: { id: { in: [agent.id, linAgent.id] } } })
      .catch(() => undefined);
    await db.workspaceMembership.deleteMany({ where: { userId: lin.id } }).catch(() => undefined);
    await db.user.delete({ where: { id: lin.id } }).catch(() => undefined);
    await db.$disconnect();
  }
}, 120_000);
