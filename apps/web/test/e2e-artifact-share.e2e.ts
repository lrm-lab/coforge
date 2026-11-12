import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { productionArtifacts } from "#src/server/artifacts/artifact-composition.server";
import { PrismaExperimentsRepository } from "#src/server/experiments/experiments.repositories.server";
import {
  browserSession,
  devBrowserWorkspace,
  localBrowserE2e,
  pageHydrated,
} from "./helpers/browser-e2e";

/**
 * An artifact's Share (task #20, #646): every member of the Workspace reads it, so the dialog
 * has nothing to choose — it says "Everyone in the Workspace" and offers only the public link
 * switch where the deployment has a sandbox origin. For an artifact of a conversation the
 * viewer is not in, the page still opens read only, with the Workspace as the way back; in a
 * Workspace where the viewer is a member only, an artifact they did not make may show the link
 * switch disabled.
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
  const { documents } = productionArtifacts(db);
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
  // A private channel the viewer is not in.
  const closed = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `e2e-share-closed-${tail}`,
      description: "",
      visibility: "private",
      members: { create: [{ agentId: agent.id }] },
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
  const workspaceRow = `${dialog}?.textContent.includes("Everyone in the Workspace")`;
  const editor = `${pageHydrated} && document.querySelector("main .ProseMirror") != null`;
  const text = (needle: string) => `document.body.textContent.includes(${JSON.stringify(needle)})`;
  const pageOf = (id: string) => `${origin}/en/w/${workspace.slug}/artifacts/${id}`;
  try {
    await experiments.write(workspaceId, "artifacts", true);
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1280", "860");
    const bot = { workspaceId, actor: { agentId: agent.id } };
    const plan = await documents.create(bot, {
      conversationId: channel.id,
      title: "Launch plan",
      text: `Plan (run ${tail}).`,
    });

    // The viewer may manage the public link: Share says every member reads it, with no choice.
    await browser("open", pageOf(plan.id));
    await browser("wait", "--fn", editor);
    await press(share);
    await until(workspaceRow);
    expect(
      await evaluate<boolean>(
        `document.querySelectorAll('[role="dialog"] input[type="radio"]').length === 0`,
      ),
    ).toBe(true);
    await shoot("1-share-workspace");
    await browser("press", "Escape");

    // An artifact of the Workspace itself: the same row; the way back is the Workspace.
    const notes = await documents.create(
      { workspaceId, actor: { userId: DEV_BROWSER_USER.id } },
      { title: "Workspace notes", text: `Notes (run ${tail}).` },
    );
    await browser("open", pageOf(notes.id));
    await browser("wait", "--fn", editor);
    expect(
      await evaluate<string>(`document.querySelector("main header a").getAttribute("href")`),
    ).toEndWith(`/w/${workspace.slug}`);
    await press(share);
    await until(workspaceRow);
    await browser("press", "Escape");

    // From a channel the viewer is not in: every member still reads it — the page opens read
    // only, with the Workspace as the way back and nothing to narrow.
    const leads = await documents.create(bot, {
      conversationId: closed.id,
      title: "Leads",
      text: `Leads (run ${tail}).`,
    });
    await browser("open", pageOf(leads.id));
    await browser("wait", "--fn", editor);
    expect(
      await evaluate<string>(`document.querySelector("main header a").getAttribute("href")`),
    ).toEndWith(`/w/${workspace.slug}`);
    expect(await evaluate<string>(`document.querySelector("main header a").textContent`)).toBe(
      "Back to the Workspace",
    );
    expect(
      await evaluate<string>(
        `document.querySelector("main .ProseMirror").getAttribute("contenteditable")`,
      ),
    ).toBe("false");
    await shoot("2-workspace-read");
    await press(share);
    await until(workspaceRow);
    expect(
      await evaluate<boolean>(`${text("won't be able to open it")} && ${text("Keep it")}`),
    ).toBe(false);
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
    const brief = await documents.create(
      { workspaceId: other.id, actor: { userId: noor.id } },
      { conversationId: noorChannel.id, title: "Brief", text: `Brief (run ${tail}).` },
    );
    await browser("open", `${origin}/en/w/${other.slug}/artifacts/${brief.id}`);
    await browser("wait", "--fn", editor);
    await press(share);
    await until(workspaceRow);
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
    await db.artifact.deleteMany({ where: { workspaceId: other.id } }).catch(() => undefined);
    await db.conversation.deleteMany({ where: { workspaceId: other.id } }).catch(() => undefined);
    await db.workspace.delete({ where: { id: other.id } }).catch(() => undefined);
    await db.user.delete({ where: { id: noor.id } }).catch(() => undefined);
    await db.agent.delete({ where: { id: agent.id } }).catch(() => undefined);
    await experiments.write(workspaceId, "artifacts", before).catch(() => undefined);
    await db.$disconnect();
  }
}, 120_000);
