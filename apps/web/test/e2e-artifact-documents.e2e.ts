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
import { sameOriginProxy } from "./helpers/same-origin-proxy";

/**
 * Documents in a conversation (task #385, the first batch; #514, their own page): a message
 * linking a document shows its card (title, first two lines); the card opens the document's own
 * page, to edit and save as a new version; a save over a version someone else changed the same
 * paragraph of asks which side to keep; an older version reads with "Back to latest" and goes back
 * as a new version; unsaved edits survive reading an older version and merge with a version
 * someone else saved; leaving with them asks; a `?doc=` link opens the page; the Files tab lists
 * the channel's documents, and New document is created only on its first save. Desktop and phone,
 * light and dark.
 *
 * Opt-in like the other browser E2Es: real local Web started with a flag file that offers
 * `artifacts` (`/tmp/coforge-flags-docs.json`, read here too). The channel, its people and its
 * documents are seeded per run and removed after it; the Workspace's switch is put back.
 * Screenshots go under `.amp/e2e/artifact-documents/`.
 */
const { origin: webOrigin, browserPath, databaseUrl } = localBrowserE2e();
const centrifugoOrigin = Bun.env.COFORGE_E2E_CENTRIFUGO_URL;
if (!centrifugoOrigin) throw new Error("COFORGE_E2E_CENTRIFUGO_URL is required");
const artifacts = join(import.meta.dir, "../../../.amp/e2e/artifact-documents");
const FLAGS = "/tmp/coforge-flags-docs.json";

const PLAN = [
  "# Goal",
  "",
  "Ship the new home page on November 15, saying clearly that people and Agents work together.",
  "",
  "# Timeline",
  "",
  "Week one design, week two build, week three test and ship.",
  "",
].join("\n");

test("a document opens from its card, saves versions, resolves a conflict and goes back", async () => {
  await installFeatureFlags(
    await readFeatureFlagsConfiguration({ COFORGE_FEATURE_FLAGS_FILE: FLAGS }),
  );
  // Centrifugo behind the page's own origin, so a version saved here reaches the page live.
  // While `held` is set, server-function answers wait for it: a save is caught in flight.
  let held: Promise<void> | undefined;
  const proxy = sameOriginProxy(webOrigin, centrifugoOrigin, {
    afterUpstream: async (url) => {
      if (held && url.pathname.includes("/_serverFn/")) await held;
    },
  });
  const origin = proxy.origin;
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `artifact-docs-${process.pid}`);
  const experiments = new PrismaExperimentsRepository(db);
  const { documents } = productionArtifacts(db);
  const { workspaceId, workspace } = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id },
    include: { workspace: { select: { slug: true } } },
  });
  const before = (await experiments.read(workspaceId)).artifacts;
  const tail = `${process.pid}-${Date.now()}`.slice(-5);
  const lin = await db.user.create({ data: { username: `lin-${tail}`, displayName: "Lin Xia" } });
  await db.workspaceMembership.create({ data: { workspaceId, userId: lin.id } });
  const channel = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `e2e-docs-${tail}`,
      description: "",
      members: { create: [{ userId: DEV_BROWSER_USER.id }, { userId: lin.id }] },
    },
  });
  const settled = () =>
    browser("wait", "--fn", `document.getAnimations().every((a) => a.playState !== "running")`);
  const shoot = async (shot: string) => {
    await settled();
    await browser("screenshot", join(artifacts, `${shot}.png`));
    await evaluate(`document.documentElement.classList.add("dark-mode") ?? true`);
    await browser("screenshot", join(artifacts, `${shot}-dark.png`));
    await evaluate(`document.documentElement.classList.remove("dark-mode") ?? true`);
  };
  // The artifact's own page, or a new document's pane beside the chat.
  const pane = `document.querySelector('[aria-label="Document"]')`;
  const inPane = (text: string) => `(${pane}?.textContent ?? "").includes(${JSON.stringify(text)})`;
  const button = (text: string, within = "document") =>
    `[...${within}.querySelectorAll("button")].find((b) => b.textContent.trim() === ${JSON.stringify(text)})`;
  const click = (selector: string) => evaluate(`(${selector}.click(), true)`);
  const version = async (artifactId: string) =>
    (await db.artifact.findUniqueOrThrow({ where: { id: artifactId } })).currentVersion;
  const until = async (check: () => Promise<boolean>) => {
    for (let i = 0; i < 60 && !(await check()); i++) await new Promise((r) => setTimeout(r, 100));
    expect(await check()).toBe(true);
  };
  const editorEnd = async () => {
    await evaluate(`(() => {
      const editor = ${pane}.querySelector(".ProseMirror");
      editor.focus();
      const range = document.createRange();
      range.selectNodeContents(editor.lastElementChild);
      range.collapse(false);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    })()`);
  };
  try {
    await experiments.write(workspaceId, "artifacts", true);
    const me = { workspaceId, actor: { userId: DEV_BROWSER_USER.id } };
    const doc = await documents.create(me, {
      conversationId: channel.id,
      title: "Home page launch plan",
      text: PLAN,
    });
    const notes = await documents.create(me, {
      conversationId: channel.id,
      title: "Weekly sync notes",
      text: "Progress, blockers and next week.",
    });
    const page = `${origin}/en/w/${workspace.slug}/channel/${channel.id}`;
    const from = await db.conversationMember.findFirstOrThrow({
      where: { conversationId: channel.id, userId: lin.id },
    });
    await db.message.create({
      data: {
        workspaceId,
        conversationId: channel.id,
        sequence: 1,
        senderMemberId: from.id,
        body: `I wrote the plan up: ${page}?doc=${doc.id}`,
      },
    });
    await db.message.create({
      data: {
        workspaceId,
        conversationId: channel.id,
        sequence: 2,
        senderMemberId: from.id,
        body: `${page}?doc=${notes.id}`,
      },
    });
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1440", "900");

    // The card: title and the first lines, in the chat.
    await browser("open", `${page}?view=chat`);
    const card = `document.querySelector('article[aria-label="Document: Home page launch plan"]')`;
    await browser("wait", "--fn", `${pageHydrated} && ${card} !== null`);
    expect(await evaluate<string>(`${card}.textContent`)).toContain("Ship the new home page");
    // Beside its card a document's link reads as its title, and a message of the link alone as
    // the card alone: no long address in the chat.
    const bodies = `[...document.querySelectorAll(".message-markdown")]`;
    await browser(
      "wait",
      "--fn",
      `${bodies}.some((body) => body.querySelector("a")?.textContent === "Home page launch plan") && !${bodies}.some((body) => body.textContent.includes("?doc="))`,
    );
    expect(
      await evaluate<boolean>(
        `document.querySelector('article[aria-label="Document: Weekly sync notes"]') !== null`,
      ),
    ).toBe(true);
    await shoot("desktop-1-card");

    // Open: its own page, editable; a save is a new version.
    await click(button("Home page launch plan", card));
    await browser("wait", "--fn", `${pane}?.querySelector(".ProseMirror") != null`);
    expect(await evaluate<string>("location.pathname")).toEndWith(`/artifacts/${doc.id}`);
    // Opening is no edit: the pane reads as saved until something is typed.
    await browser("wait", "--fn", inPane("Saved · version 1"));
    await editorEnd();
    await browser("keyboard", "type", " Owners: design coforge-ui.");
    await browser("wait", "--fn", inPane("Unsaved changes"));
    await shoot("desktop-2-editing");
    await click(button("Save", pane));
    await until(async () => (await version(doc.id)) === 2);
    await browser("wait", "--fn", inPane("Saved · version 2"));

    // Lin changes the timeline while the viewer changes it too: the save asks which to keep.
    await documents.save(
      { workspaceId, actor: { userId: lin.id } },
      {
        artifactId: doc.id,
        baseVersion: 2,
        idempotencyKey: crypto.randomUUID(),
        text: (await documents.load(me, { artifactId: doc.id })).text.replace(
          "Week one design, week two build, week three test and ship.",
          "Nov 1–7 design (coforge-ui); Nov 8–14 build (builder); Nov 15 ship (Frank).",
        ),
      },
    );
    await browser("wait", "--fn", inPane("published version 3"));
    // Nothing was unsaved: the pane took version 3 in. Edit the same paragraph from version 2.
    await evaluate(`(() => {
      const para = [...${pane}.querySelectorAll(".ProseMirror p")].find((p) => p.textContent.startsWith("Nov 1"));
      ${pane}.querySelector(".ProseMirror").focus();
      const range = document.createRange();
      range.selectNodeContents(para);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    })()`);
    await browser(
      "keyboard",
      "type",
      "Week one design and copy, week two build, ship on the 15th.",
    );
    await browser("wait", "--fn", inPane("Unsaved changes"));
    // A save over version 2, as a page that had not taken version 3 in would make.
    await documents.save(
      { workspaceId, actor: { userId: lin.id } },
      {
        artifactId: doc.id,
        baseVersion: 3,
        idempotencyKey: crypto.randomUUID(),
        text: (await documents.load(me, { artifactId: doc.id })).text.replace(
          "Nov 15 ship (Frank).",
          "Nov 15 test and ship (Frank).",
        ),
      },
    );
    await browser("wait", "--fn", inPane("published version 4"));
    await click(button("Save", pane));
    await browser("wait", "--fn", inPane("Conflicts · not saved"));
    expect(await evaluate<boolean>(inPane("conflicts with your changes"))).toBe(true);
    await shoot("desktop-3-conflict");
    await evaluate(`([...${pane}.querySelectorAll('input[type="radio"]')][0].click(), true)`);
    await browser("wait", "--fn", inPane("1 of 1 conflicts picked"));
    // While the resolution saves, nothing in it can change and it cannot be thrown away (N1).
    let release = () => {};
    held = new Promise((resolve) => (release = resolve));
    await click(button("Save", pane));
    await until(async () => (await version(doc.id)) === 5);
    await browser(
      "wait",
      "--fn",
      `${button("Discard my changes", pane)}?.disabled === true && [...${pane}.querySelectorAll('input[type="radio"]')].every((radio) => radio.disabled)`,
    );
    held = undefined;
    release();
    expect((await documents.load(me, { artifactId: doc.id })).text).toContain(
      "Week one design and copy",
    );

    // History: version 1 reads with "Back to latest" and goes back as version 6.
    await click(`${pane}.querySelector('button[aria-label="Version history"]')`);
    await browser("wait", "--fn", inPane("Version 1"));
    const row = (n: number) =>
      `[...${pane}.querySelectorAll("nav li button")].find((b) => b.textContent.startsWith("Version ${n}"))`;
    await click(row(1));
    await browser("wait", "--fn", inPane("Viewing version 1"));
    await shoot("desktop-4-old-version");
    await click(button("Go back to this version", pane));
    const confirm = `[...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.trim() === "Go back to this version")`;
    await browser("wait", "--fn", `${confirm} != null`);
    await click(confirm);
    await until(async () => (await version(doc.id)) === 6);
    await browser("wait", "--fn", `!${inPane("Viewing version")}`);

    await shoot("desktop-5-page");

    // Unsaved edits stay while an older version is read, and closing with them asks first.
    await editorEnd();
    await browser("keyboard", "type", " Draft note.");
    await browser("wait", "--fn", inPane("Unsaved changes"));
    // The history is still open from going back.
    await browser("wait", "--fn", `${row(2)} != null`);
    await click(row(2));
    await browser("wait", "--fn", inPane("Viewing version 2"));
    await click(button("Back to latest", pane));
    await browser("wait", "--fn", `${pane}?.querySelector(".ProseMirror") != null`);
    expect(await evaluate<string>(`${pane}.querySelector(".ProseMirror").textContent`)).toContain(
      "Draft note.",
    );
    expect(await evaluate<boolean>(inPane("Unsaved changes"))).toBe(true);

    // Lin saves another paragraph meanwhile: the unsaved edit stays, and the save merges both.
    await documents.save(
      { workspaceId, actor: { userId: lin.id } },
      {
        artifactId: doc.id,
        baseVersion: 6,
        idempotencyKey: crypto.randomUUID(),
        text: (await documents.load(me, { artifactId: doc.id })).text.replace(
          "# Goal",
          "# Goal (agreed)",
        ),
      },
    );
    await browser("wait", "--fn", inPane("published version 7"));
    expect(await evaluate<string>(`${pane}.querySelector(".ProseMirror").textContent`)).toContain(
      "Draft note.",
    );
    await click(button("Save", pane));
    await until(async () => (await version(doc.id)) === 8);
    const merged = (await documents.load(me, { artifactId: doc.id })).text;
    expect(merged).toContain("# Goal (agreed)");
    expect(merged).toContain("Draft note.");
    await browser("wait", "--fn", inPane("Saved · version 8"));

    await editorEnd();
    await browser("keyboard", "type", " One more.");
    await browser("wait", "--fn", inPane("Unsaved changes"));
    const dialogButton = (text: string) =>
      `[...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)})`;
    // Back to the channel, from the page's header.
    const back = `${pane}.querySelector("header a")`;
    await click(back);
    await browser("wait", "--fn", `${dialogButton("Keep Editing")} != null`);
    await click(dialogButton("Keep Editing"));
    await browser("wait", "--fn", `${dialogButton("Keep Editing")} == null`);
    expect(await evaluate<boolean>(`${pane} != null`)).toBe(true);
    await click(back);
    await browser("wait", "--fn", `${dialogButton("Discard Changes")} != null`);
    await click(dialogButton("Discard Changes"));
    await browser("wait", "--fn", `${pane} == null`);

    // A link from before the page (`?doc=`) opens the page.
    await browser("open", `${page}?doc=${notes.id}`);
    await browser("wait", "--fn", `location.pathname.endsWith("/artifacts/${notes.id}")`);

    // The Files tab: the channel's documents, newest first, and New document.
    await browser("open", `${page}?view=files`);
    await browser(
      "wait",
      "--fn",
      `${pageHydrated} && document.body.textContent.includes("Weekly sync notes")`,
    );
    await shoot("desktop-6-files");

    // New document is a draft until its first save: closed unwritten, it leaves nothing.
    const count = () => db.artifact.count({ where: { homeKey: `conversation:${channel.id}` } });
    const documentsBefore = await count();
    await click(button("New document"));
    await browser("wait", "--fn", `${pane}?.querySelector(".ProseMirror") != null`);
    await click(`${pane}.querySelector('button[aria-label="Close"]')`);
    await browser("wait", "--fn", `${pane} == null`);
    expect(await count()).toBe(documentsBefore);
    await click(button("New document"));
    await browser("wait", "--fn", `${pane}?.querySelector(".ProseMirror") != null`);
    await evaluate(`(${pane}.querySelector("textarea").focus(), true)`);
    await browser("keyboard", "type", "Launch checklist");
    // Enter moves into the text; tiptap focuses it a frame later.
    await browser("press", "Enter");
    await browser(
      "wait",
      "--fn",
      `document.activeElement === ${pane}.querySelector(".ProseMirror")`,
    );
    await browser("keyboard", "type", "Copy, images, analytics.");
    await click(button("Save", pane));
    await until(async () => (await count()) === documentsBefore + 1);
    await browser("wait", "--fn", `location.pathname.includes("/artifacts/")`);
    await browser("wait", "--fn", inPane("Saved · version 1"));
    const draft = await db.artifact.findFirstOrThrow({
      where: { homeKey: `conversation:${channel.id}` },
      orderBy: { createdAt: "desc" },
    });
    expect(draft.title).toBe("Launch checklist");
    expect((await documents.load(me, { artifactId: draft.id })).text).toContain("analytics");

    // The phone: the card, then the document over the chat.
    await browser("set", "viewport", "390", "844");
    await browser("open", `${page}?view=chat`);
    await browser("wait", "--fn", `${pageHydrated} && ${card} !== null`);
    await evaluate(`(${card}.scrollIntoView({ block: "center" }), true)`);
    await shoot("phone-1-card");
    await click(button("Home page launch plan", card));
    await browser("wait", "--fn", `${pane}?.querySelector(".ProseMirror") != null`);
    await shoot("phone-2-document");
  } finally {
    await browser("close").catch(() => undefined);
    proxy.stop();
    await db.artifact
      .deleteMany({ where: { homeKey: `conversation:${channel.id}` } })
      .catch(() => undefined);
    await db.conversation.deleteMany({ where: { id: channel.id } }).catch(() => undefined);
    await db.workspaceMembership.deleteMany({ where: { userId: lin.id } }).catch(() => undefined);
    await db.user.delete({ where: { id: lin.id } }).catch(() => undefined);
    await experiments.write(workspaceId, "artifacts", before ?? false).catch(() => undefined);
    await db.$disconnect();
  }
}, 240_000);
