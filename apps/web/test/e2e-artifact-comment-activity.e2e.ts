import { test, expect } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { productionArtifacts } from "#src/server/artifacts/artifact-composition.server";
import { readFeatureFlagsConfiguration } from "#src/server/feature-flags/configuration.server";
import { installFeatureFlags } from "#src/server/feature-flags/feature-flags.server";
import { agentWrites } from "./helpers/artifact-agent-writes";
import {
  browserSession,
  devBrowserWorkspace,
  localBrowserE2e,
  pageHydrated,
} from "./helpers/browser-e2e";
import { ActivityInbox } from "#src/server/inbox/activity-inbox.server";
import { sameOriginProxy } from "./helpers/same-origin-proxy";

const { origin: webOrigin, browserPath, databaseUrl } = localBrowserE2e();
const centrifugoOrigin = Bun.env.COFORGE_E2E_CENTRIFUGO_URL;
if (!centrifugoOrigin) throw new Error("COFORGE_E2E_CENTRIFUGO_URL is required");
const shots =
  Bun.env.COFORGE_E2E_SHOTS_DIR ??
  join(import.meta.dir, "../../../.artifacts/e2e/artifact-comment-activity");
const locale = Bun.env.COFORGE_E2E_LOCALE ?? "en";
const [width, height] = (Bun.env.COFORGE_E2E_VIEWPORT ?? "1280x860").split("x");

test("a person's Activity shows a second person's comment and review live and opens the artifact on the review", async () => {
  await installFeatureFlags(
    await readFeatureFlagsConfiguration({
      COFORGE_FEATURE_FLAGS_FILE: "/tmp/coforge-flags-docs.json",
    }),
  );
  const proxy = sameOriginProxy(webOrigin, centrifugoOrigin, {});
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const session = browserSession(browserPath, `artifact-activity-${process.pid}`);
  const { browser, evaluate, waitFor } = session;
  const services = productionArtifacts(db);
  const { workspaceId, workspace } = await devBrowserWorkspace(db);
  const tail = `${process.pid}-${Date.now()}`.slice(-6);
  const agent = await db.agent.create({
    data: {
      workspaceId,
      name: `e2e-ac-${tail}`,
      displayName: "Scribe",
      ownerId: DEV_BROWSER_USER.id,
      runtimeConfig: {},
    },
  });
  const lin = await db.user.create({ data: { username: `lin-a-${tail}`, displayName: "Lin Xia" } });
  await db.workspaceMembership.create({ data: { workspaceId, userId: lin.id } });
  const channel = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `e2e-ac-${tail}`,
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
  const rows = `[...document.querySelectorAll("[data-activity-artifact]")]`;
  const result: Record<string, unknown> = {};
  try {
    await mkdir(shots, { recursive: true });
    await browser("set", "viewport", width!, height!);
    const artifact = await bot.create({
      conversationId: channel.id,
      title: `Launch plan ${tail}`,
      files: { "index.md": `# Launch plan\n\nShip on Friday ${tail}.\n` },
      entry: "index.md",
    });
    await services.personFollows.set({
      workspaceId,
      artifactId: artifact.id,
      userId: DEV_BROWSER_USER.id,
      following: true,
    });
    await browser("open", `${proxy.origin}/${locale}/w/${workspace.slug}/activity`);
    await waitFor(
      `${pageHydrated} && document.querySelector("[data-activity-list]") != null`,
      60_000,
    );
    expect(await evaluate<number>(`${rows}.length`)).toBe(0);

    const comment = await services.comments.post({
      workspaceId,
      userId: lin.id,
      artifactId: artifact.id,
      comment: { body: `Is Friday firm ${tail}?`, idempotencyKey: `e2e-${tail}-c` },
    });
    await waitFor(
      `${rows}.some((row) => row.textContent.includes("Is Friday firm ${tail}"))`,
      30_000,
    );
    expect(await evaluate<number>(`${rows}.length`)).toBe(1);
    await shoot("70-activity-artifact-item");

    await services.drafts.create({
      workspaceId,
      artifactId: artifact.id,
      userId: lin.id,
      draft: { version: 1, body: `Overall fine ${tail}` },
    });
    const review = await services.drafts.submit({
      workspaceId,
      artifactId: artifact.id,
      userId: lin.id,
      draftIds: (
        await services.drafts.list({ workspaceId, artifactId: artifact.id, userId: lin.id })
      ).drafts.map(({ id }) => id),
      clientKey: crypto.randomUUID(),
    });
    if (review.status !== "sent") throw new Error("the review was refused");
    await waitFor(
      `${rows}.some((row) => row.textContent.includes("Overall fine ${tail}"))`,
      30_000,
    );
    expect(await evaluate<number>(`${rows}.length`)).toBe(1);
    result.items = 1;

    await services.comments.post({
      workspaceId,
      userId: lin.id,
      artifactId: artifact.id,
      comment: {
        body: `@${DEV_BROWSER_USER.username} please look ${tail}`,
        idempotencyKey: `e2e-${tail}-m`,
      },
    });
    await waitFor(`${rows}.some((row) => row.textContent.includes("please look ${tail}"))`, 30_000);
    await shoot("71-activity-mention");

    await browser("eval", `${rows}[0].querySelector("a").click()`);
    await waitFor(
      `location.pathname.endsWith("/artifacts/${artifact.id}") && ${pageHydrated}`,
      60_000,
    );
    await waitFor(`document.querySelector("aside [data-comment-thread]") != null`, 60_000);
    expect(comment.id).toBeString();
    result.opened = await evaluate<string>(`location.search`);
    await browser("open", `${proxy.origin}/${locale}/w/${workspace.slug}/activity`);
    await waitFor(
      `${pageHydrated} && document.querySelector("[data-activity-list]") != null`,
      60_000,
    );
    expect(await evaluate<number>(`${rows}.length`)).toBe(1);
    expect(await evaluate<boolean>(`${rows}[0].querySelector(".bg-brand-solid") == null`)).toBe(
      true,
    );

    const openActivity = async () => {
      await browser("open", `${proxy.origin}/${locale}/w/${workspace.slug}/activity`);
      await waitFor(
        `${pageHydrated} && document.querySelector("[data-activity-list]") != null`,
        60_000,
      );
    };
    const sendReview = async (body: string) => {
      const draft = await services.drafts.create({
        workspaceId,
        artifactId: artifact.id,
        userId: lin.id,
        draft: { version: 1, body },
      });
      const sent = await services.drafts.submit({
        workspaceId,
        artifactId: artifact.id,
        userId: lin.id,
        draftIds: [draft.id],
        clientKey: crypto.randomUUID(),
      });
      if (sent.status !== "sent") throw new Error("a review was refused");
      return sent;
    };
    const inbox = new ActivityInbox(db, {});
    const unreadKeys = async () =>
      (await inbox.navAttention(workspaceId, DEV_BROWSER_USER.id)).unreadKeys ?? [];
    await sendReview(`Second review ${tail}`);
    await waitFor(
      `${rows}.length === 1 && ${rows}[0].querySelector(".bg-brand-solid") != null`,
      30_000,
    );
    expect(await unreadKeys()).toContain(`artifact:${artifact.id}`);
    await browser("eval", `${rows}[0].querySelector("a").focus()`);
    await browser("press", "r");
    await waitFor(
      `${rows}.length === 1 && ${rows}[0].querySelector(".bg-brand-solid") == null`,
      30_000,
    );
    expect(await unreadKeys()).not.toContain(`artifact:${artifact.id}`);
    await shoot("72-activity-artifact-read");
    await browser("press", "e");
    await waitFor(`${rows}.length === 0`, 30_000);
    await shoot("73-activity-artifact-done");
    const again = await sendReview(`Third review ${tail}`);
    await waitFor(`${rows}.length === 1`, 30_000);
    const cleared = await inbox.markAllDone(workspaceId, DEV_BROWSER_USER.id, {
      before: new Date(),
    });
    await openActivity();
    expect(await evaluate<number>(`${rows}.length`)).toBe(0);
    await inbox.undoDone(workspaceId, DEV_BROWSER_USER.id, cleared.undo!);
    await openActivity();
    expect(await evaluate<number>(`${rows}.length`)).toBe(1);
    await browser("eval", `${rows}[0].querySelector("a").click()`);
    await waitFor(`document.querySelector("[data-review-chip]") != null`, 60_000);
    expect(await evaluate<string>(`location.search`)).toContain(`review=${again.reviewId}`);
    result.review = again.reviewId;
    await writeFile(join(shots, "activity-result.json"), JSON.stringify(result, null, 2));
  } catch (error) {
    await browser("screenshot", join(shots, "activity-failure.png")).catch(() => undefined);
    throw error;
  } finally {
    await browser("close").catch(() => undefined);
    proxy.stop();
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
