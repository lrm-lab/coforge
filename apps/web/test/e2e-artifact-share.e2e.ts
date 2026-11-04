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
 * Who can see an artifact, from its page's Share (task #514): for an artifact of a conversation,
 * its two levels greyed as coming soon; for an artifact of the Workspace, one level, and the way
 * back is the Workspace.
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
  const settled = () =>
    browser("wait", "--fn", `document.getAnimations().every((a) => a.playState !== "running")`);
  const shoot = async (shot: string) => {
    await settled();
    await browser("screenshot", join(artifacts, `${shot}.png`));
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
  const pageOf = (id: string) => `${origin}/en/w/${workspace.slug}/artifacts/${id}`;
  try {
    await experiments.write(workspaceId, "artifacts", true);
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1280", "860");
    const plan = await documents.create(
      { workspaceId, actor: { agentId: agent.id } },
      { conversationId: channel.id, title: "Launch plan", text: `Plan (run ${tail}).` },
    );

    // Share, before who can see it is stored (task #529): the levels greyed, as coming soon.
    await browser("open", pageOf(plan.id));
    await browser("wait", "--fn", editor);
    await press(share);
    await browser("wait", "--fn", `${radios}.length === 2`);
    expect(await evaluate<boolean>(`${radios}.every((radio) => radio.disabled)`)).toBe(true);
    const group = `document.querySelector('[role="dialog"] [role="radiogroup"]')`;
    expect(
      await evaluate<string>(
        `document.getElementById(${group}.getAttribute("aria-describedby")).textContent`,
      ),
    ).toContain("coming soon");
    await shoot("1-share-soon");
    await browser("press", "Escape");
    await browser("wait", "--fn", `document.querySelector('[role="dialog"]') == null`);

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
  } finally {
    await browser("close").catch(() => undefined);
    await db.artifact
      .deleteMany({
        where: {
          OR: [
            { homeKey: `conversation:${channel.id}` },
            { workspaceId, title: "Workspace notes", preview: { contains: tail } },
          ],
        },
      })
      .catch(() => undefined);
    await db.conversation.delete({ where: { id: channel.id } }).catch(() => undefined);
    await experiments.write(workspaceId, "artifacts", before).catch(() => undefined);
    await db.$disconnect();
  }
}, 120_000);
