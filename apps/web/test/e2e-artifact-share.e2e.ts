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

/**
 * Who can see an artifact, from its page's Share (task #514, #529): for an artifact of a
 * conversation, its two levels, a change of them stored, and one that finds it deleted; for an
 * artifact of the Workspace, one level, and the way back is the Workspace; and one of a
 * conversation the viewer is not in, read only through the Workspace level: the way back is the
 * Workspace, the editor and an old version read only, and the narrower level confirmed before it
 * shuts the viewer out; and in a Workspace where the viewer is a member only, an artifact they
 * did not make: Share greyed, saying who can change it.
 *
 * Opt-in like the other browser E2Es: real local Web started with the flag file that offers
 * `artifacts` (`/tmp/coforge-flags-docs.json`, read here too). Its texts carry the run's tail,
 * since bytes are stored once per Workspace by their hash. Screenshots go under
 * `.amp/e2e/artifact-share/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/artifact-share");

test("an artifact's Share: who can see it", async () => {
  await installFeatureFlags(
    await readFeatureFlagsConfiguration({
      COFORGE_FEATURE_FLAGS_FILE: "/tmp/coforge-flags-docs.json",
    }),
  );
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `artifact-share-${process.pid}`);
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
  const radios = `[...document.querySelectorAll('[role="dialog"] input[type="radio"]')]`;
  const editor = `${pageHydrated} && document.querySelector("main .ProseMirror") != null`;
  const text = (needle: string) => `document.body.textContent.includes(${JSON.stringify(needle)})`;
  const button = (label: string) =>
    `[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === ${JSON.stringify(label)})`;
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

    // The viewer may change who can see it: the change is stored, and shown.
    await browser("open", pageOf(plan.id));
    await browser("wait", "--fn", editor);
    await press(share);
    await browser("wait", "--fn", `${radios}.length === 2`);
    expect(await evaluate<boolean>(`${radios}.some((radio) => radio.disabled)`)).toBe(false);
    const level = (name: string) =>
      `[...document.querySelectorAll('[role="dialog"] label')].find((l) => l.textContent.includes(${JSON.stringify(name)}))`;
    await press(level("Everyone in the Workspace"));
    await until(
      `${level("Everyone in the Workspace")}.querySelector("input").checked && !${radios}.some((radio) => radio.disabled)`,
    );
    expect((await db.artifact.findUniqueOrThrow({ where: { id: plan.id } })).access).toBe(
      "workspace",
    );
    await shoot("1-share-workspace");

    // Deleted while Share is open: the change finds it gone, and the page says it cannot open it.
    await db.artifact.update({ where: { id: plan.id }, data: { deletedAt: new Date() } });
    await press(level("People in"));
    await until(`document.body.textContent.includes("Can't open this")`);
    expect(await evaluate<boolean>(`document.querySelector('[role="dialog"]') == null`)).toBe(true);

    // An artifact of the Workspace itself: one level, everyone in it; the way back is the Workspace.
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
    await browser("wait", "--fn", `${radios}.length === 1`);
    expect(
      await evaluate<string>(
        `document.querySelector('[role="dialog"] [role="radiogroup"]').textContent`,
      ),
    ).toContain("Everyone in the Workspace");
    await browser("press", "Escape");

    // Shared with the Workspace from a channel the viewer is not in: read through that level
    // alone, with no conversation to go back to, and only read from the first.
    const leads = await documents.create(bot, {
      conversationId: closed.id,
      title: "Leads",
      text: `Leads (run ${tail}).`,
    });
    await db.artifact.update({ where: { id: leads.id }, data: { access: "workspace" } });
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

    // An old version of it: nothing to go back to it with.
    await documents.save(bot, {
      artifactId: leads.id,
      baseVersion: 1,
      idempotencyKey: crypto.randomUUID(),
      text: `Leads, version 2 (run ${tail}).`,
    });
    await browser("open", `${pageOf(leads.id)}?version=1`);
    await browser("wait", "--fn", `${pageHydrated} && ${button("Back to latest")} != null`);
    expect(await evaluate<boolean>(`${button("Go back to this version")} == null`)).toBe(true);

    // The narrower level would shut the viewer out: asked first, then back to the Workspace.
    await browser("open", pageOf(leads.id));
    await browser("wait", "--fn", editor);
    await press(share);
    await browser("wait", "--fn", `${radios}.length === 2`);
    await press(level("People in this conversation"));
    await until(text("you won't be able to open it yourself"));
    await shoot("3-lock-out-confirm");
    await press(button("Keep it"));
    await until(`!${text("you won't be able to open it yourself")}`);
    expect(
      await evaluate<boolean>(
        `${level("Everyone in the Workspace")}.querySelector("input").checked`,
      ),
    ).toBe(true);
    await press(level("People in this conversation"));
    await until(text("you won't be able to open it yourself"));
    await press(button("Change it"));
    await until(
      `location.pathname.includes("/w/${workspace.slug}") && !location.pathname.includes("/artifacts/") && ${text("Only people in its conversation can see")}`,
    );
    expect((await db.artifact.findUniqueOrThrow({ where: { id: leads.id } })).access).toBe(
      "conversation",
    );

    // A member only, of an artifact they did not make: Share greyed, saying who can change it.
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
    await browser("wait", "--fn", `${radios}.length === 2`);
    expect(await evaluate<boolean>(`${radios}.every((radio) => radio.disabled)`)).toBe(true);
    const group = `document.querySelector('[role="dialog"] [role="radiogroup"]')`;
    expect(
      await evaluate<string>(
        `document.getElementById(${group}.getAttribute("aria-describedby")).textContent`,
      ),
    ).toContain("Only its author");
    await shoot("4-member-greyed");
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
    await experiments.write(workspaceId, "artifacts", before).catch(() => undefined);
    await db.$disconnect();
  }
}, 120_000);
