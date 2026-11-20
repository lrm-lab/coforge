import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { productionArtifacts } from "#src/server/artifacts/artifact-composition.server";
import { readFeatureFlagsConfiguration } from "#src/server/feature-flags/configuration.server";
import { installFeatureFlags } from "#src/server/feature-flags/feature-flags.server";
import { agentWrites } from "./helpers/artifact-agent-writes";
import { PDF } from "./helpers/test-pdf";
import {
  browserSession,
  devBrowserWorkspace,
  localBrowserE2e,
  pageHydrated,
} from "./helpers/browser-e2e";

const { origin: webOrigin, browserPath, databaseUrl } = localBrowserE2e();
const sandboxOrigin = Bun.env.COFORGE_ARTIFACT_SANDBOX_ORIGIN;
if (!sandboxOrigin) throw new Error("COFORGE_ARTIFACT_SANDBOX_ORIGIN is required");
const shots =
  Bun.env.COFORGE_E2E_SHOTS_DIR ??
  join(import.meta.dir, "../../../.artifacts/e2e/artifact-file-preview");

test("a non-entry page runs on the artifact's origin and a PDF shows from it", async () => {
  await installFeatureFlags(
    await readFeatureFlagsConfiguration({
      COFORGE_FEATURE_FLAGS_FILE: "/tmp/coforge-flags-docs.json",
    }),
  );
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate, waitFor, clickText } = browserSession(
    browserPath,
    `file-preview-${process.pid}`,
  );
  const { workspaceId, workspace } = await devBrowserWorkspace(db);
  const tail = `${process.pid}-${Date.now()}`.slice(-6);
  const agent = await db.agent.create({
    data: {
      workspaceId,
      name: `e2e-preview-${tail}`,
      displayName: "Scribe",
      ownerId: DEV_BROWSER_USER.id,
      runtimeConfig: {},
    },
  });
  const channel = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `e2e-preview-${tail}`,
      description: "",
      members: { create: [{ userId: DEV_BROWSER_USER.id }, { agentId: agent.id }] },
    },
  });
  const bot = agentWrites(productionArtifacts(db), workspaceId, agent.id);
  try {
    await mkdir(shots, { recursive: true });
    await browser("set", "viewport", "1920", "898");
    const created = await bot.create({
      conversationId: channel.id,
      title: "Report",
      entry: "README.md",
      files: {
        "README.md": `# Report ${tail}`,
        "pages/two.html": `<!doctype html><title>${tail}</title><a href="three.html">three</a><script>document.body.dataset.origin = location.origin</script>`,
        "pages/three.html": "<!doctype html><p>three</p>",
        "docs/paper.pdf": PDF,
      },
    });
    await browser("open", `${webOrigin}/zh-CN/w/${workspace.slug}/artifacts/${created.id}`);
    await waitFor(`${pageHydrated} && document.querySelector("main") != null`);
    const openFile = async (path: string) => {
      await browser("find", "role", "button", "click", "--name", "更多操作");
      await browser("find", "role", "menuitem", "click", "--name", "文件");
      await clickText("button", path);
    };
    await openFile("pages/two.html");
    await waitFor(`document.querySelector("main iframe") != null`);
    const frame = await evaluate<string>(`document.querySelector("main iframe").src`);
    expect(new URL(frame).host).toBe(`a-${created.id}.${new URL(sandboxOrigin).host}`);
    await browser("screenshot", join(shots, "82-non-entry-html.png"));
    await openFile("docs/paper.pdf");
    await waitFor(
      `document.querySelector("main iframe") != null && !document.querySelector("main iframe").hasAttribute("sandbox")`,
    );
    const pdf = await evaluate<{ src: string; sandboxed: boolean }>(
      `(() => { const f = document.querySelector("main iframe"); return { src: f.src, sandboxed: f.hasAttribute("sandbox") }; })()`,
    );
    expect(new URL(pdf.src).host).toBe(`a-${created.id}.${new URL(sandboxOrigin).host}`);
    expect(pdf.sandboxed).toBe(false);
    await browser("screenshot", join(shots, "83-pdf.png"));
    await evaluate(
      `(() => { const f = document.querySelector("main iframe"); f.src = f.getAttribute("src"); return true; })()`,
    );
    await waitFor(`document.body.textContent.includes("这个视图已失效")`);
    await browser("screenshot", join(shots, "84-pdf-expired.png"));
    await browser("find", "role", "button", "click", "--name", "重新加载");
    await waitFor(
      `!document.body.textContent.includes("这个视图已失效") && document.querySelector("main iframe")?.src !== ${JSON.stringify(pdf.src)}`,
    );
  } finally {
    await db.conversation.delete({ where: { id: channel.id } }).catch(() => undefined);
    await db.agent.delete({ where: { id: agent.id } }).catch(() => undefined);
    await db.$disconnect();
    await browser("close").catch(() => undefined);
  }
}, 120_000);
