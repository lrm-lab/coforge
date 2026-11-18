import { test, expect } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { productionArtifacts } from "#src/server/artifacts/artifact-composition.server";
import { PrismaExperimentsRepository } from "#src/server/experiments/experiments.repositories.server";
import { readFeatureFlagsConfiguration } from "#src/server/feature-flags/configuration.server";
import { installFeatureFlags } from "#src/server/feature-flags/feature-flags.server";
import { agentWrites } from "./helpers/artifact-agent-writes";
import {
  browserSession,
  devBrowserWorkspace,
  localBrowserE2e,
  pageHydrated,
} from "./helpers/browser-e2e";
import { sameOriginProxy } from "./helpers/same-origin-proxy";

const { origin: webOrigin, browserPath, databaseUrl } = localBrowserE2e();
const centrifugoOrigin = Bun.env.COFORGE_E2E_CENTRIFUGO_URL;
if (!centrifugoOrigin) throw new Error("COFORGE_E2E_CENTRIFUGO_URL is required");
const shots =
  Bun.env.COFORGE_E2E_SHOTS_DIR ??
  join(import.meta.dir, "../../../.artifacts/e2e/artifact-comment-drafts");
const locale = Bun.env.COFORGE_E2E_LOCALE ?? "en";
const [width, height] = (Bun.env.COFORGE_E2E_VIEWPORT ?? "1280x860").split("x");

test("a person saves drafts, undoes and redoes, sends them as one review, and a refused send sends nothing", async () => {
  await installFeatureFlags(
    await readFeatureFlagsConfiguration({
      COFORGE_FEATURE_FLAGS_FILE: "/tmp/coforge-flags-docs.json",
    }),
  );
  const proxy = sameOriginProxy(webOrigin, centrifugoOrigin, {});
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const session = browserSession(browserPath, `artifact-drafts-${process.pid}`);
  const { browser, evaluate, waitFor } = session;
  const experiments = new PrismaExperimentsRepository(db);
  const services = productionArtifacts(db);
  const { workspaceId, workspace } = await devBrowserWorkspace(db);
  const before = (await experiments.read(workspaceId)).artifacts;
  const tail = `${process.pid}-${Date.now()}`.slice(-6);
  const agent = await db.agent.create({
    data: {
      workspaceId,
      name: `e2e-dr-${tail}`,
      displayName: "Scribe",
      ownerId: DEV_BROWSER_USER.id,
      runtimeConfig: {},
    },
  });
  const lin = await db.user.create({ data: { username: `lin-d-${tail}`, displayName: "Lin Xia" } });
  await db.workspaceMembership.create({ data: { workspaceId, userId: lin.id } });
  const channel = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `e2e-dr-${tail}`,
      description: "",
      members: {
        create: [{ userId: DEV_BROWSER_USER.id }, { userId: lin.id }, { agentId: agent.id }],
      },
    },
  });
  const bot = agentWrites(services, workspaceId, agent.id);
  const shoot = async (shot: string) => {
    await waitFor(`document.getAnimations().every((a) => a.playState !== "running")`);
    await browser("screenshot", join(shots, `${shot}.png`));
  };
  const click = (selector: string) =>
    browser(
      "eval",
      `(() => { const target = document.querySelector(${JSON.stringify(selector)}); target?.click(); return Boolean(target); })()`,
    );
  const select = (needle: string) =>
    browser(
      "eval",
      `(() => {
        const walker = document.createTreeWalker(document.querySelector(".ProseMirror"), NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const at = node.data.indexOf(${JSON.stringify(needle)});
          if (at === -1) continue;
          const range = document.createRange();
          range.setStart(node, at);
          range.setEnd(node, at + ${needle.length});
          getSelection().removeAllRanges();
          getSelection().addRange(range);
          return true;
        }
        return false;
      })()`,
    );
  const count = (selector: string) =>
    `document.querySelectorAll(${JSON.stringify(selector)}).length`;
  const sendLabelHasCount = (n: number) =>
    `(document.querySelector("[data-draft-send]")?.textContent ?? "").includes("${n}")`;
  const draftBodies = () =>
    evaluate<string[]>(
      `[...document.querySelectorAll("[data-draft-group] [data-draft-id]")].map((card) => card.textContent)`,
    );
  const saveSelection = async (needle: string, text: string) => {
    await select(needle);
    await waitFor(`document.querySelector("[data-comment-selection]") != null`);
    await click("[data-comment-selection] button");
    await waitFor(`document.querySelector("[data-comment-popover] textarea") != null`);
    await browser("fill", "[data-comment-popover] textarea", text);
    await click("[data-comment-popover] [data-save-draft]");
    await waitFor(`document.querySelector("[data-comment-popover]") == null`);
  };
  const first = `beta ${tail} on Friday`;
  const second = `Pricing is open for ${tail}`;
  const markdown = `# Launch plan\n\nShip the ${first}.\n\n${second} review.\n`;
  const result: Record<string, unknown> = {};
  try {
    await experiments.write(workspaceId, "artifacts", true);
    await mkdir(shots, { recursive: true });
    await browser("set", "viewport", width!, height!);
    const artifact = await bot.create({
      conversationId: channel.id,
      title: "Launch plan",
      files: { "index.md": markdown },
      entry: "index.md",
    });
    const pageUrl = `${proxy.origin}/${locale}/w/${workspace.slug}/artifacts/${artifact.id}`;
    await browser("open", pageUrl);
    await waitFor(`${pageHydrated} && document.querySelector(".ProseMirror") != null`, 60_000);

    await click("button[aria-pressed]");
    await waitFor(`document.querySelector("aside") != null`);

    const lead = await services.comments.post({
      workspaceId,
      userId: lin.id,
      artifactId: artifact.id,
      comment: { body: `Is this firm ${tail}?`, idempotencyKey: `e2e-${tail}-lead` },
    });
    await waitFor(`document.querySelector('[data-comment-thread="${lead.id}"]') != null`);

    await saveSelection(first, `Friday is risky ${tail}`);
    await waitFor(count("[data-draft-group] [data-draft-id]") + " === 1");
    await saveSelection(second, `Check the price ${tail}`);
    await waitFor(count("[data-draft-group] [data-draft-id]") + " === 2");
    await click(`[data-comment-thread="${lead.id}"] article div.absolute button`);
    await waitFor(`document.querySelector("aside form textarea") != null`);
    await browser("fill", "aside form textarea", `Yes, it is firm ${tail}`);
    await click("aside form [data-save-draft]");
    await waitFor(count("[data-draft-group] [data-draft-id]") + " === 3");
    await waitFor(sendLabelHasCount(3));
    await waitFor(count("[data-draft-marker]") + " === 2");
    const saved = await draftBodies();
    expect(saved[0]).toContain(`Friday is risky ${tail}`);
    expect(saved[1]).toContain(`Check the price ${tail}`);
    expect(saved[2]).toContain(`Yes, it is firm ${tail}`);
    await shoot("60-drafts-panel");
    await shoot("61-review-pill");
    await shoot("62-draft-markers");

    const middle = await evaluate<string>(
      `document.querySelectorAll("[data-draft-group] [data-draft-id]")[1].dataset.draftId`,
    );
    await click(`[data-draft-id="${middle}"] [data-draft-delete]`);
    await waitFor(count("[data-draft-group] [data-draft-id]") + " === 2");
    await waitFor(sendLabelHasCount(2));
    await click("[data-draft-undo]");
    await waitFor(count("[data-draft-group] [data-draft-id]") + " === 3");
    await click("[data-draft-redo]");
    await waitFor(count("[data-draft-group] [data-draft-id]") + " === 2");
    await click("[data-draft-undo]");
    await waitFor(count("[data-draft-group] [data-draft-id]") + " === 3");
    await waitFor(`document.querySelector("[data-draft-redo]").disabled === false`);
    expect((await draftBodies())[1]).toContain(`Check the price ${tail}`);

    const sentBefore = await services.drafts.list({
      workspaceId,
      artifactId: artifact.id,
      userId: DEV_BROWSER_USER.id,
    });
    expect(sentBefore.drafts).toHaveLength(3);
    const marked = (body: string) => ({ type: "text" as const, data: { quote: body } });
    const linsFirst = await services.drafts.create({
      workspaceId,
      artifactId: artifact.id,
      userId: lin.id,
      draft: {
        version: 1,
        path: "index.md",
        anchor: marked(first),
        body: `Lin: agreed on Friday ${tail}`,
      },
    });
    await services.drafts.create({
      workspaceId,
      artifactId: artifact.id,
      userId: lin.id,
      draft: { version: 1, body: `Lin: overall fine ${tail}` },
    });
    const linsReview = await services.drafts.submit({
      workspaceId,
      artifactId: artifact.id,
      userId: lin.id,
      draftIds: (
        await services.drafts.list({ workspaceId, artifactId: artifact.id, userId: lin.id })
      ).drafts.map(({ id }) => id),
      clientKey: crypto.randomUUID(),
    });
    if (linsReview.status !== "sent") throw new Error("Lin's review was refused");
    expect(linsFirst.id).toBeString();
    await waitFor(
      `[...document.querySelectorAll("[data-comment-thread]")].filter((thread) => thread.textContent.includes("Lin:")).length === 2`,
    );

    await click("[data-draft-send]");
    await waitFor(`document.querySelector("[data-draft-send]") == null`);
    await waitFor(
      `[...document.querySelectorAll("[data-comment-thread]")].filter((thread) => thread.textContent.includes("${tail}")).length >= 5`,
    );
    const mine = await db.artifactCommentReview.findFirstOrThrow({
      where: { artifactId: artifact.id, authorUserId: DEV_BROWSER_USER.id },
    });
    const mineComments = await db.artifactComment.findMany({
      where: { reviewId: mine.id },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    expect(mineComments.map((comment) => comment.body)).toEqual([
      `Friday is risky ${tail}`,
      `Check the price ${tail}`,
      `Yes, it is firm ${tail}`,
    ]);
    expect(mineComments[2]!.rootId).toBe(lead.id);
    result.review = { id: mine.id, bodies: mineComments.map((comment) => comment.body) };

    await browser("open", `${pageUrl}?review=${linsReview.reviewId}`);
    await waitFor(
      `${pageHydrated} && document.querySelector("[data-review-chip]") != null`,
      60_000,
    );
    await waitFor(
      `document.querySelectorAll("[data-review-comments] [data-comment-thread]").length === 2`,
    );
    expect(
      await evaluate<boolean>(
        `[...document.querySelectorAll("[data-review-comments] [data-comment-thread]")].every((thread) => thread.textContent.includes("Lin:"))`,
      ),
    ).toBe(true);
    result.filteredReview = { id: linsReview.reviewId, comments: 2 };
    await click("[data-review-chip] button");
    await waitFor(`document.querySelector("[data-review-chip]") == null`);

    await click("button[aria-pressed]");
    await waitFor(`document.querySelector("aside") != null`);
    const linsLead = await services.comments.post({
      workspaceId,
      userId: lin.id,
      artifactId: artifact.id,
      comment: { body: `Soon gone ${tail}`, idempotencyKey: `e2e-${tail}-gone` },
    });
    await waitFor(`document.querySelector('[data-comment-thread="${linsLead.id}"]') != null`);
    await click(`[data-comment-thread="${linsLead.id}"] article div.absolute button`);
    await waitFor(`document.querySelector("aside form textarea") != null`);
    await browser("fill", "aside form textarea", `Reply to a vanishing note ${tail}`);
    await click("aside form [data-save-draft]");
    await waitFor(sendLabelHasCount(1));
    await services.comments.remove({
      workspaceId,
      userId: lin.id,
      artifactId: artifact.id,
      commentId: linsLead.id,
    });
    await click("[data-draft-send]");
    await waitFor(`document.querySelector("[data-pending-banner=refused]") != null`);
    await waitFor(`document.querySelector('[data-draft-id][aria-invalid="true"]') != null`);
    await shoot("63-submit-refused");
    expect(
      await db.artifactCommentReview.count({
        where: { artifactId: artifact.id, authorUserId: DEV_BROWSER_USER.id },
      }),
    ).toBe(1);
    expect(
      await db.artifactCommentDraft.count({
        where: { artifactId: artifact.id, userId: DEV_BROWSER_USER.id },
      }),
    ).toBe(1);
    result.refused = { drafts: 1, reviews: 1 };
    await writeFile(join(shots, "drafts-result.json"), JSON.stringify(result, null, 2));
  } catch (error) {
    await browser("screenshot", join(shots, "drafts-failure.png")).catch(() => undefined);
    throw error;
  } finally {
    await browser("close").catch(() => undefined);
    proxy.stop();
    await experiments.write(workspaceId, "artifacts", before);
    await db.artifact
      .deleteMany({ where: { homeKey: `conversation:${channel.id}` } })
      .catch(() => undefined);
    await db.conversation.delete({ where: { id: channel.id } }).catch(() => undefined);
    await db.agent.delete({ where: { id: agent.id } }).catch(() => undefined);
    await db.workspaceMembership.deleteMany({ where: { workspaceId, userId: lin.id } });
    await db.user.delete({ where: { id: lin.id } }).catch(() => undefined);
    await db.$disconnect();
  }
}, 300_000);
