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
  Bun.env.COFORGE_E2E_SHOTS_DIR ?? join(import.meta.dir, "../../../.amp/e2e/artifact-file-entry");

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="#2f6f4f"/></svg>`;

test("an artifact whose entry is a PDF, a CSV or an image opens as that file", async () => {
  await installFeatureFlags(
    await readFeatureFlagsConfiguration({
      COFORGE_FEATURE_FLAGS_FILE: "/tmp/coforge-flags-docs.json",
    }),
  );
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate, waitFor } = browserSession(browserPath, `file-entry-${process.pid}`);
  const experiments = new PrismaExperimentsRepository(db);
  const { workspaceId, workspace } = await devBrowserWorkspace(db);
  const before = (await experiments.read(workspaceId)).artifacts;
  const tail = `${process.pid}-${Date.now()}`.slice(-6);
  const agent = await db.agent.create({
    data: {
      workspaceId,
      name: `e2e-entry-${tail}`,
      displayName: "Scribe",
      ownerId: DEV_BROWSER_USER.id,
      runtimeConfig: {},
    },
  });
  const channel = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `e2e-entry-${tail}`,
      description: "",
      members: { create: [{ userId: DEV_BROWSER_USER.id }, { agentId: agent.id }] },
    },
  });
  const bot = agentWrites(productionArtifacts(db), workspaceId, agent.id);
  const page = (id: string) => `${webOrigin}/zh-CN/w/${workspace.slug}/artifacts/${id}`;
  try {
    await experiments.write(workspaceId, "artifacts", true);
    await mkdir(shots, { recursive: true });
    await browser("set", "viewport", "1920", "898");
    const make = (title: string, entry: string, text: string) =>
      bot.create({ conversationId: channel.id, title, entry, files: { [entry]: text } });
    const paper = await make(`Paper ${tail}`, "paper.pdf", PDF);
    const sheet = await make(`Sheet ${tail}`, "people.csv", "name,team\nAlice,Ops\nBob,Web\n");
    const logo = await make(`Logo ${tail}`, "logo.svg", SVG);

    await browser("open", page(paper.id));
    await waitFor(
      `${pageHydrated} && document.querySelector('main iframe[aria-label="paper.pdf"]') != null`,
    );
    const pdf = await evaluate<{ sandboxed: boolean; back: boolean; kind: string | null }>(
      `(() => ({
        sandboxed: document.querySelector("main iframe").hasAttribute("sandbox"),
        back: [...document.querySelectorAll("main button")].some((b) => b.textContent.includes("回到 Artifact")),
        kind: document.querySelector("header [data-artifact-kind]")?.getAttribute("data-artifact-kind") ?? null,
      }))()`,
    );
    expect(pdf).toEqual({ sandboxed: false, back: false, kind: "pdf" });
    await browser("screenshot", join(shots, "90-pdf-entry.png"));

    await browser("open", page(sheet.id));
    await waitFor(
      `${pageHydrated} && [...document.querySelectorAll("main td")].some((c) => c.textContent === "Alice")`,
    );
    await browser("screenshot", join(shots, "91-csv-entry.png"));

    await bot.push(
      sheet.id,
      1,
      { "people.csv": "name,team\nAlice,Ops\nBob,Web\n", "notes.md": "# Roster notes\n" },
      "notes.md",
    );
    await browser("open", page(sheet.id));
    await waitFor(
      `${pageHydrated} && document.querySelector("main")?.innerText.includes("Roster notes")`,
    );
    await browser("open", `${page(sheet.id)}?version=1`);
    await waitFor(
      `${pageHydrated} && [...document.querySelectorAll("main td")].some((c) => c.textContent === "Alice")`,
    );

    await browser("open", page(logo.id));
    await waitFor(
      `(() => { const img = document.querySelector('main img[alt="logo.svg"]'); return ${pageHydrated} && !!img && img.complete && img.naturalWidth > 0; })()`,
    );
    expect(
      await evaluate<string>(
        `new URL(document.querySelector('main img[alt="logo.svg"]').src).pathname + new URL(document.querySelector('main img[alt="logo.svg"]').src).search`,
      ),
    ).toBe(
      `/api/workspaces/${encodeURIComponent(workspace.slug)}/artifacts/${logo.id}/download?path=logo.svg&version=1`,
    );
    await browser("screenshot", join(shots, "92-image-entry.png"));

    await browser("open", `${webOrigin}/zh-CN/w/${workspace.slug}/artifacts`);
    await waitFor(`${pageHydrated} && document.body.innerText.includes("Paper ${tail}")`);
    const card = (title: string) =>
      `[...document.querySelectorAll("article")].find((card) => card.innerText.includes(${JSON.stringify(title)}))`;
    expect(
      await evaluate<string | null>(
        `${card(`Paper ${tail}`)}?.querySelector("span[data-artifact-kind]:not([aria-hidden])")?.getAttribute("data-artifact-kind") ?? null`,
      ),
    ).toBe("pdf");
    await waitFor(
      `(() => { const img = ${card(`Logo ${tail}`)}?.querySelector('img[data-artifact-kind="image"]'); return !!img && img.complete && img.naturalWidth > 0; })()`,
    );
    await browser("screenshot", join(shots, "93-gallery-kinds.png"));

    const roster = await make(`Roster ${tail}`, "roster.csv", "name,team\nAlice,Ops\nBob,Web\n");
    const sender = await db.conversationMember.findFirstOrThrow({
      where: { conversationId: channel.id, agentId: agent.id },
      select: { id: true },
    });
    const link = (id: string) => `${webOrigin}/w/${workspace.slug}/artifacts/${id}`;
    await db.message.create({
      data: {
        conversationId: channel.id,
        workspaceId,
        senderMemberId: sender.id,
        body: `Files: ${link(paper.id)} ${link(roster.id)} ${link(logo.id)}`,
        sequence: 1,
      },
    });
    await browser("open", `${webOrigin}/zh-CN/w/${workspace.slug}/channel/${channel.id}`);
    await waitFor(
      `${pageHydrated} && document.querySelectorAll("[data-artifact-facts]").length === 3`,
    );
    const titles = [`Paper ${tail}`, `Roster ${tail}`, `Logo ${tail}`];
    const facts = await evaluate<string[]>(
      `[${titles.map(card).join(",")}].map((card) => card?.querySelector("[data-artifact-facts]")?.textContent ?? null)`,
    );
    expect(facts).toEqual(["共 1 页", "2 行 × 2 列 · name、team", "120 × 60 像素"]);
    await browser("screenshot", join(shots, "94-chat-card-facts.png"));
  } finally {
    await experiments.write(workspaceId, "artifacts", before);
    await db.conversation.delete({ where: { id: channel.id } }).catch(() => undefined);
    await db.agent.delete({ where: { id: agent.id } }).catch(() => undefined);
    await db.$disconnect();
    await browser("close").catch(() => undefined);
  }
}, 120_000);
