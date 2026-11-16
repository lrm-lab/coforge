import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { productionArtifacts } from "#src/server/artifacts/artifact-composition.server";
import { agentWrites } from "./helpers/artifact-agent-writes";
import { PrismaExperimentsRepository } from "#src/server/experiments/experiments.repositories.server";
import {
  browserSession,
  devBrowserWorkspace,
  localBrowserE2e,
  pageHydrated,
} from "./helpers/browser-e2e";

/**
 * An artifact's Share and who it is seen by: its home's readers read it, and its page's way back
 * is that conversation; one of a private channel the viewer is not in is "Can't open this" until
 * its author Agent moves it to the Workspace, when it opens read only with the Workspace as the
 * way back. Share opens for what the viewer reads (in a Workspace where the viewer is a member
 * only, an artifact they did not make may show the link switch disabled).
 *
 * Opt-in like the other browser E2Es: real local Web with the `artifacts` experiment switched
 * on per Workspace (it has no flag). Its texts carry the run's tail, since bytes are stored once
 * per Workspace by their hash. Screenshots go under `.amp/e2e/artifact-share/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/artifact-share");

test("an artifact's Share: who can see it", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `artifact-share-${process.pid}`);
  const experiments = new PrismaExperimentsRepository(db);
  const services = productionArtifacts(db);
  const { workspaceId, workspace } = await devBrowserWorkspace(db);
  const before = (await experiments.read(workspaceId)).artifacts;
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
  // A Workspace the viewer is only a member of, owned by Noor, whose artifact the viewer reads.
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
  const settled = () =>
    browser("wait", "--fn", `document.getAnimations().every((a) => a.playState !== "running")`);
  const shoot = async (shot: string) => {
    await settled();
    await browser("screenshot", join(artifacts, `${shot}.png`));
  };
  const until = async (expression: string) => {
    for (let i = 0; i < 100; i++) {
      if (await evaluate<boolean>(expression)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`Timed out waiting for ${expression}`);
  };
  /** A real click, which a dialog's trigger needs to keep its focus (a scripted one is virtual). */
  const press = async (selector: string) => {
    await evaluate(`(${selector}.setAttribute("data-press", ""), true)`);
    await browser("click", "[data-press]");
    await evaluate(`(document.querySelector("[data-press]")?.removeAttribute("data-press"), true)`);
  };
  const share = `[...document.querySelectorAll("main header button")].find((b) => b.textContent.trim() === "Share")`;
  const dialog = `document.querySelector('[role="dialog"]')`;
  const shareOpen = `${dialog}?.textContent.includes("Copy link")`;
  const viewer = `${pageHydrated} && document.querySelector("main .ProseMirror") != null`;
  const text = (needle: string) => `document.body.textContent.includes(${JSON.stringify(needle)})`;
  const pageOf = (id: string) => `${origin}/en/w/${workspace.slug}/artifacts/${id}`;
  try {
    await experiments.write(workspaceId, "artifacts", true);
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1280", "860");
    const bot = agentWrites(services, workspaceId, agent.id);
    const linBot = agentWrites(services, workspaceId, linAgent.id);
    const plan = await bot.create({
      conversationId: channel.id,
      title: "Launch plan",
      files: { "plan.md": `Plan (run ${tail}).` },
    });

    // From the home the viewer is in: the way back is the channel, and Share has no level to pick.
    await browser("open", pageOf(plan.id));
    await browser("wait", "--fn", viewer);
    expect(
      await evaluate<string>(`document.querySelector("main header a").getAttribute("href")`),
    ).toEndWith(`/channel/${channel.id}`);
    await press(share);
    await until(shareOpen);
    expect(
      await evaluate<boolean>(
        `document.querySelectorAll('[role="dialog"] input[type="radio"]').length === 0`,
      ),
    ).toBe(true);
    await shoot("1-share-channel-home");
    await browser("press", "Escape");

    // From a private channel the viewer is not in: not theirs to open.
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
    await shoot("2-closed-home-unavailable");

    // Moved to the Workspace by its author Agent (its owner reads it): it opens read only, and
    // the way back is the Workspace.
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
    await shoot("3-workspace-read");
    await press(share);
    await until(shareOpen);
    await browser("press", "Escape");

    // A member only, of an artifact they did not make: where a public link exists its switch is
    // disabled for them; where none does, Share still says who reads it.
    await experiments.write(other.id, "artifacts", true);
    const noorChannel = await db.conversation.create({
      data: {
        workspaceId: other.id,
        channelName: `e2e-share-noor-${tail}`,
        description: "",
        members: { create: [{ userId: noor.id }, { userId: DEV_BROWSER_USER.id }] },
      },
    });
    // An Agent of Noor's makes it; the viewer neither owns that Agent nor administers the Workspace.
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
    await press(share);
    await until(shareOpen);
    expect(
      await evaluate<boolean>(
        `(() => { const s = document.querySelector('[role="dialog"] input[role="switch"]'); return s == null || s.disabled; })()`,
      ),
    ).toBe(true);
    await shoot("4-member-share");
    await browser("press", "Escape");
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
    await experiments.write(workspaceId, "artifacts", before).catch(() => undefined);
    await db.$disconnect();
  }
}, 120_000);
