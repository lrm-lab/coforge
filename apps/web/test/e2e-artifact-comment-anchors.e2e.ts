import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { avatarPresetReference, avatarPresets } from "#src/features/profiles/avatar-presets";
import { PrismaClient } from "#src/generated/prisma/client";
import { defaultPersonPictureId } from "#src/lib/person-picture";
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
  join(import.meta.dir, "../../../.amp/e2e/artifact-comment-anchors");
const locale = Bun.env.COFORGE_E2E_LOCALE ?? "en";
const [width, height] = (Bun.env.COFORGE_E2E_VIEWPORT ?? "1280x860").split("x");

test("people comment on a selection and on lines; markers show beside the text on the version they were written on", async () => {
  await installFeatureFlags(
    await readFeatureFlagsConfiguration({
      COFORGE_FEATURE_FLAGS_FILE: "/tmp/coforge-flags-docs.json",
    }),
  );
  const proxy = sameOriginProxy(webOrigin, centrifugoOrigin, {});
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const session = browserSession(browserPath, `artifact-anchors-${process.pid}`);
  const { browser, evaluate, waitFor } = session;
  const experiments = new PrismaExperimentsRepository(db);
  const services = productionArtifacts(db);
  const { workspaceId, workspace } = await devBrowserWorkspace(db);
  const before = (await experiments.read(workspaceId)).artifacts;
  const tail = `${process.pid}-${Date.now()}`.slice(-6);
  const agent = await db.agent.create({
    data: {
      workspaceId,
      name: `e2e-an-${tail}`,
      displayName: "Scribe",
      ownerId: DEV_BROWSER_USER.id,
      runtimeConfig: {},
    },
  });
  const lin = await db.user.create({ data: { username: `lin-a-${tail}`, displayName: "Lin Xia" } });
  const chosenFace = (userId: string) =>
    avatarPresets.find((preset) => preset.id !== defaultPersonPictureId(userId))!;
  const devFace = await db.user.findUniqueOrThrow({
    where: { id: DEV_BROWSER_USER.id },
    select: { avatarObjectKey: true, avatarContentType: true },
  });
  await db.workspaceMembership.create({ data: { workspaceId, userId: lin.id } });
  const channel = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `e2e-an-${tail}`,
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
  const threadText = (id: string) =>
    `document.querySelector('[data-comment-thread="${id}"]')?.textContent ?? ""`;
  const quoted = `beta ${tail} on Friday`;
  const markdown = (sentence: string) =>
    `# Launch plan\n\nShip the ${sentence}.\n\nPricing is open for ${tail} review.\n`;
  const lines = "const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\n";
  const table = 'name,note\nLee,"first\nsecond"\nBo,ok\n';
  try {
    for (const userId of [lin.id, DEV_BROWSER_USER.id])
      await db.user.update({
        where: { id: userId },
        data: {
          avatarObjectKey: avatarPresetReference(chosenFace(userId).id),
          avatarContentType: null,
        },
      });
    await experiments.write(workspaceId, "artifacts", true);
    await mkdir(shots, { recursive: true });
    await browser("set", "viewport", width!, height!);
    const artifact = await bot.create({
      conversationId: channel.id,
      title: "Launch plan",
      files: { "index.md": markdown(quoted), "app.js": lines, "data.csv": table },
      entry: "index.md",
    });
    await browser("open", `${proxy.origin}/${locale}/w/${workspace.slug}/artifacts/${artifact.id}`);
    await waitFor(`${pageHydrated} && document.querySelector(".ProseMirror") != null`, 60_000);

    await click("button[aria-pressed]");
    await waitFor(`document.querySelector("aside") != null`);
    await shoot("32-markdown-comment-mode");
    await select(quoted);
    await waitFor(`document.querySelector("[data-comment-selection]") != null`);
    await shoot("33-markdown-text-selected");
    await click("[data-comment-selection] button");
    await waitFor(
      `document.querySelector("[data-comment-popover]")?.textContent.includes(${JSON.stringify(quoted)})`,
    );
    await browser("fill", "[data-comment-popover] textarea", `Is Friday firm ${tail}?`);
    await shoot("34-markdown-composer-with-anchor");
    await click('[data-comment-popover] button[type="submit"]');
    await waitFor(`document.querySelector("[data-comment-popover]") == null`);
    await waitFor(
      `document.querySelector("[data-comment-thread]")?.textContent.includes(${JSON.stringify(quoted)})`,
    );
    const mine = await evaluate<string>(
      `document.querySelector("[data-comment-thread]").dataset.commentThread`,
    );
    await waitFor(`document.querySelectorAll("[data-comment-marker]").length === 1`);

    const secondQuote = `Pricing is open for ${tail}`;
    const second = await services.comments.post({
      workspaceId,
      userId: lin.id,
      artifactId: artifact.id,
      comment: {
        body: `Pricing needs a second look ${tail}`,
        path: "index.md",
        anchor: { type: "text", data: { quote: secondQuote, suffix: " review." } },
        idempotencyKey: `e2e-${tail}-second`,
      },
    });
    await waitFor(`document.querySelectorAll("[data-comment-marker]").length === 2`);
    await shoot("35-margin-markers");
    const showsChosen = (selector: string, userId: string) =>
      `document.querySelector(${JSON.stringify(`${selector} img[data-avatar-img]`)})?.getAttribute("src") === ${JSON.stringify(chosenFace(userId).url)}`;
    await waitFor(showsChosen(`[data-comment-thread="${second.id}"]`, lin.id));
    await waitFor(showsChosen(`[data-comment-marker="${second.id}"]`, lin.id));
    await waitFor(showsChosen('button[aria-label="Who is viewing"]', DEV_BROWSER_USER.id));
    await waitFor(
      `[...document.querySelectorAll("[data-comment-thread]")].map((thread) => thread.dataset.commentThread).join() === ${JSON.stringify(`${mine},${second.id}`)}`,
    );
    await click(`[data-comment-marker="${second.id}"]`);
    await waitFor(
      `(${threadText(second.id)}).includes("Pricing needs a second look") && (${threadText(second.id)}).includes(${JSON.stringify(secondQuote)})`,
    );

    const revised = {
      "index.md": markdown("launch on Friday"),
      "app.js": lines,
      "data.csv": table,
    };
    await bot.push(artifact.id, 1, revised).catch(() => bot.push(artifact.id, 1, revised));
    await waitFor(`document.querySelector('[role="status"] button') != null`);
    await click('[role="status"] button');
    await waitFor(
      `document.querySelector('[data-version-section="1"] [data-comment-thread="${mine}"] [data-anchor-status="elsewhere"]') != null`,
    );
    await waitFor(`document.querySelectorAll("[data-comment-marker]").length === 0`);
    expect(await evaluate<number>(`CSS.highlights.get("artifact-comment-focus")?.size ?? 0`)).toBe(
      0,
    );
    await shoot("36-anchor-other-version");
    await click(`[data-comment-thread="${mine}"] [data-comment-anchor]`);
    await waitFor(
      `document.querySelector('[data-comment-thread="${mine}"] [data-anchor-status="found"]') != null && document.querySelector('[data-comment-marker="${mine}"]') != null`,
    );
    await waitFor(
      `document.querySelector('[data-comment-thread="${second.id}"] [data-anchor-status="found"]') != null`,
    );
    await shoot("36-anchor-on-its-version");

    await browser(
      "open",
      `${proxy.origin}/${locale}/w/${workspace.slug}/artifacts/${artifact.id}?comment=${mine}`,
    );
    await waitFor(
      `document.querySelector('[data-comment-thread="${mine}"] [data-anchor-status="found"]') != null`,
    );
    await click('button[aria-pressed="false"]');
    await waitFor(`document.querySelector('[data-comment-marker="${mine}"]') != null`);
    await shoot("36-comment-link-on-its-version");

    const onLines = await services.comments.post({
      workspaceId,
      userId: lin.id,
      artifactId: artifact.id,
      comment: {
        body: `Why constant b ${tail}`,
        path: "app.js",
        anchor: { type: "lines", data: { start: 2, end: 2 } },
        idempotencyKey: `e2e-${tail}-lines`,
      },
    });
    await waitFor(`document.querySelector('[data-comment-thread="${onLines.id}"]') != null`);
    await click(`[data-comment-thread="${onLines.id}"] [data-comment-anchor]`);
    await waitFor(`document.querySelector('[data-anchor-line="3"]') != null`);
    await click('[data-anchor-select="3"]');
    await browser(
      "eval",
      `document.querySelector('[data-anchor-select="4"]').dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }))`,
    );
    await waitFor(`document.querySelector("[data-comment-selection]") != null`);
    await click("[data-comment-selection] button");
    await waitFor(`document.querySelector("[data-comment-popover]") != null`);
    await browser("fill", "[data-comment-popover] textarea", `Drop these two ${tail}`);
    await shoot("37-code-lines");
    await click('[data-comment-popover] button[type="submit"]');
    await waitFor(`document.querySelector("[data-comment-popover]") == null`);
    await waitFor(
      `[...document.querySelectorAll("[data-comment-thread]")].some((thread) => thread.textContent.includes("Drop these two ${tail}") && thread.textContent.includes("app.js"))`,
    );
    await browser("eval", `document.querySelector('[data-anchor-select="1"]').focus()`);
    await browser("press", "Enter");
    await waitFor(`document.querySelector("[data-comment-selection]") != null`);
    await click("[data-comment-selection] button");
    await waitFor(
      `document.querySelector("[data-comment-popover]")?.textContent.includes("Line 1")`,
    );
    await browser("press", "Escape");
    await waitFor(`document.querySelector("[data-comment-popover]") == null`);

    const onTable = await services.comments.post({
      workspaceId,
      userId: lin.id,
      artifactId: artifact.id,
      comment: {
        body: `Is Bo right ${tail}`,
        path: "data.csv",
        anchor: { type: "lines", data: { start: 4, end: 4 } },
        idempotencyKey: `e2e-${tail}-table`,
      },
    });
    const openTable = async () => {
      await waitFor(`document.querySelector('[data-comment-thread="${onTable.id}"]') != null`);
      await click(`[data-comment-thread="${onTable.id}"] [data-comment-anchor]`);
      await waitFor(
        `[...document.querySelectorAll("[data-anchor-select]")].map((cell) => cell.textContent).join() === "1,2,4"`,
      );
    };
    await openTable();
    await waitFor(
      `document.querySelector('[data-comment-thread="${onTable.id}"] [data-anchor-status="found"]') != null`,
    );
    await click('[data-anchor-select="2"]');
    await waitFor(`document.querySelector("[data-comment-selection]") != null`);
    await click("[data-comment-selection] button");
    await waitFor(`document.querySelector("[data-comment-popover]")?.textContent.includes("2–3")`);
    await click(`[data-comment-thread="${onLines.id}"] [data-comment-anchor]`);
    await waitFor(
      `document.querySelector('[data-anchor-line="3"]') != null && document.querySelector("table") == null`,
    );
    await waitFor(
      `document.querySelector("[data-comment-popover]") == null && document.querySelector("[data-comment-selection]") == null`,
    );

    await openTable();
    await click('[data-anchor-select="2"]');
    await waitFor(`document.querySelector("[data-comment-selection]") != null`);
    await click("[data-comment-selection] button");
    await waitFor(`document.querySelector("[data-comment-popover]") != null`);
    await browser("fill", "[data-comment-popover] textarea", `Two lines in one row ${tail}`);
    await click('[data-comment-popover] button[type="submit"]');
    await waitFor(`document.querySelector("[data-comment-popover]") == null`);
    await waitFor(
      `[...document.querySelectorAll("[data-comment-thread]")].some((thread) => thread.textContent.includes("Two lines in one row ${tail}") && thread.textContent.includes("2–3"))`,
    );
  } finally {
    await db.user
      .update({ where: { id: DEV_BROWSER_USER.id }, data: devFace })
      .catch(() => undefined);
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
}, 240_000);
