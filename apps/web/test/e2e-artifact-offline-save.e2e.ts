import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { productionArtifacts } from "#src/server/artifacts/artifact-composition.server";
import { PrismaExperimentsRepository } from "#src/server/experiments/experiments.repositories.server";
import { chromePath, launchHeadlessChrome, until } from "./helpers/headless-chrome";

/**
 * Task #514, item 10 (QA on staging, 11-05): a document edited while offline says it could not
 * save and offers Try again, instead of "Saving…" with no end; typing on sends nothing more;
 * leaving asks first, as nothing could save the edits; back online, what was typed saves by
 * itself.
 *
 * Opt-in like the other browser E2Es: the real local Web and a headless Chrome, taken offline
 * through DevTools. The run turns the Workspace's Documents switch on and puts it back; the
 * channel and document are seeded per run and removed after it.
 */
const origin = Bun.env.COFORGE_E2E_WEB_URL;
const databaseUrl = Bun.env.DATABASE_URL;
const chrome = chromePath();

test("a document typed in offline says it could not save, and saves once back online", async () => {
  if (!origin || !["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
    throw new Error("COFORGE_E2E_WEB_URL must target the local Web service");
  if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1")
    throw new Error("DATABASE_URL must target local PostgreSQL");
  if (!chrome) throw new Error("Chrome is required (COFORGE_E2E_CHROME)");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const experiments = new PrismaExperimentsRepository(db);
  const { documents } = productionArtifacts(db);
  const { workspaceId, workspace } = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id },
    include: { workspace: { select: { slug: true } } },
  });
  const before = (await experiments.read(workspaceId)).artifacts;
  const tail = `${process.pid}-${Date.now()}`.slice(-5);
  const channel = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `e2e-offline-save-${tail}`,
      description: "",
      members: { create: [{ userId: DEV_BROWSER_USER.id }] },
    },
  });
  const browser = await launchHeadlessChrome(chrome);
  try {
    await experiments.write(workspaceId, "artifacts", true);
    const doc = await documents.create(
      { workspaceId, actor: { userId: DEV_BROWSER_USER.id } },
      { conversationId: channel.id, title: "Offline notes", text: `Written online (run ${tail}).` },
    );
    const saved = async () =>
      (await db.artifact.findUniqueOrThrow({ where: { id: doc.id } })).currentVersion;
    const first = await saved();
    const page = await browser.open(`${origin}/en/w/${workspace.slug}/artifacts/${doc.id}`);
    await until(
      () => page.evaluate<boolean>(`document.querySelector(".ProseMirror") != null`),
      60_000,
    );
    await page.evaluate(`(() => {
      const editor = document.querySelector(".ProseMirror");
      editor.focus();
      const range = document.createRange();
      range.selectNodeContents(editor.lastElementChild);
      range.collapse(false);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      return true;
    })()`);

    const network = (offline: boolean) =>
      page.command("Network.emulateNetworkConditions", {
        offline,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
      });
    await page.command("Network.enable");
    await network(true);
    expect(await page.evaluate<boolean>("navigator.onLine")).toBe(false);
    await page.command("Input.insertText", { text: ` Typed offline ${tail}.` });

    // Once typing rests the save fails at once: the line says so and offers Try again.
    const failure = `[...document.querySelectorAll("span")].find((el) => el.textContent.startsWith("Couldn't save: you're offline"))`;
    await until(() => page.evaluate<boolean>(`${failure} != null`), 10_000);
    expect(
      await page.evaluate<boolean>(
        `[...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Try again")`,
      ),
    ).toBe(true);
    expect(await saved()).toBe(first);
    // While typing on offline, no save goes out to fail again: the line stays.
    await page.evaluate(`(() => {
      window.__saves = 0;
      const send = window.fetch;
      window.fetch = (...args) => (window.__saves += 1, send(...args));
      return true;
    })()`);
    await page.command("Input.insertText", { text: " More." });
    await Bun.sleep(2_500);
    expect(await page.evaluate<number>("window.__saves")).toBe(0);
    expect(await page.evaluate<boolean>(`${failure} != null`)).toBe(true);

    // Leaving now would lose the edits (no save can go out): it asks first, and staying keeps them.
    await page.evaluate(`document.querySelector('a[href*="/channel/${channel.id}"]').click()`);
    const asks = `document.body.textContent.includes("This document has unsaved changes. Leaving loses them.")`;
    await until(() => page.evaluate<boolean>(asks), 10_000);
    await page.evaluate(
      `[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Keep Editing").click()`,
    );
    await until(() => page.evaluate<boolean>(`!(${asks})`));
    expect(await page.evaluate<string>("location.pathname")).toEndWith(`/artifacts/${doc.id}`);

    // Back online, it saves by itself and the line goes.
    await network(false);
    await until(async () => (await saved()) > first, 15_000);
    await until(() => page.evaluate<boolean>(`${failure} == null`));
    const latest = await documents.load(
      { workspaceId, actor: { userId: DEV_BROWSER_USER.id } },
      { artifactId: doc.id },
    );
    expect(latest.text).toContain(`Typed offline ${tail}. More.`);
  } finally {
    await browser.close();
    await experiments.write(workspaceId, "artifacts", before).catch(() => undefined);
    await db.artifact
      .deleteMany({ where: { homeKey: `conversation:${channel.id}` } })
      .catch(() => undefined);
    await db.conversation.deleteMany({ where: { id: channel.id } }).catch(() => undefined);
    await db.$disconnect();
  }
}, 120_000);
