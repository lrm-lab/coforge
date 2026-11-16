import { test } from "bun:test";
import { mkdir } from "node:fs/promises";
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
const shots = join(import.meta.dir, "../../../.amp/e2e/artifact-comments");

test("people comment on an artifact, see each other live, resolve, and use the phone sheet", async () => {
  await installFeatureFlags(
    await readFeatureFlagsConfiguration({
      COFORGE_FEATURE_FLAGS_FILE: "/tmp/coforge-flags-docs.json",
    }),
  );
  const proxy = sameOriginProxy(webOrigin, centrifugoOrigin, {});
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const session = browserSession(browserPath, `artifact-comments-${process.pid}`);
  const { browser, evaluate, waitFor } = session;
  const experiments = new PrismaExperimentsRepository(db);
  const services = productionArtifacts(db);
  const { workspaceId, workspace } = await devBrowserWorkspace(db);
  const before = (await experiments.read(workspaceId)).artifacts;
  const tail = `${process.pid}-${Date.now()}`.slice(-6);
  const agent = await db.agent.create({
    data: {
      workspaceId,
      name: `e2e-cm-${tail}`,
      displayName: "Scribe",
      ownerId: DEV_BROWSER_USER.id,
      runtimeConfig: {},
    },
  });
  const lin = await db.user.create({ data: { username: `lin-c-${tail}`, displayName: "Lin Xia" } });
  await db.workspaceMembership.create({ data: { workspaceId, userId: lin.id } });
  const channel = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `e2e-cm-${tail}`,
      description: "",
      members: {
        create: [{ userId: DEV_BROWSER_USER.id }, { userId: lin.id }, { agentId: agent.id }],
      },
    },
  });
  const bot = agentWrites(services, workspaceId, agent.id);
  const text = (needle: string) => `document.body.textContent.includes(${JSON.stringify(needle)})`;
  const shoot = async (shot: string) => {
    await waitFor(`document.getAnimations().every((a) => a.playState !== "running")`);
    await browser("screenshot", join(shots, `${shot}.png`));
  };
  try {
    await experiments.write(workspaceId, "artifacts", true);
    await mkdir(shots, { recursive: true });
    await browser("set", "viewport", "1280", "860");
    const artifact = await bot.create({
      conversationId: channel.id,
      title: "Launch plan",
      files: { "index.md": `# Launch plan\n\nrun ${tail}\n` },
    });
    await browser("open", `${proxy.origin}/en/w/${workspace.slug}/artifacts/${artifact.id}`);
    await waitFor(`${pageHydrated} && document.querySelector("main") != null`, 60_000);

    await browser("find", "role", "button", "click", "--name", "Comment on this artifact");
    await waitFor(`document.querySelector('aside[aria-label="Comments"]') != null`);
    await waitFor(text("No comments yet"));
    await shoot("1-empty-panel");

    await browser("find", "role", "textbox", "fill", `Check the dates ${tail}`);
    await browser("find", "role", "button", "click", "--name", "Send");
    await waitFor(
      `document.querySelector("[data-comment-id]") != null && ${text(`Check the dates ${tail}`)}`,
    );
    await shoot("2-posted");

    const root = await evaluate<string>(
      `document.querySelector("[data-comment-id]").dataset.commentId`,
    );
    await services.comments.post({
      workspaceId,
      userId: lin.id,
      artifactId: artifact.id,
      comment: { body: `Dates look fine ${tail}`, replyTo: root, idempotencyKey: `e2e-${tail}` },
    });
    await waitFor(text(`Dates look fine ${tail}`));
    await waitFor(text("Lin Xia"));
    await shoot("3-live-reply");

    await browser("find", "role", "button", "click", "--name", "Resolve");
    await waitFor(text("Resolved (1)"));
    await shoot("4-resolved");

    await browser("set", "viewport", "390", "844");
    await waitFor(
      `(() => { const panel = document.querySelector('aside[aria-label="Comments"]'); if (!panel) return false; const box = panel.getBoundingClientRect(); return box.width >= 380 && box.bottom >= 840; })()`,
    );
    await shoot("5-phone-sheet");
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
}, 180_000);
