import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { productionArtifacts } from "#src/server/artifacts/artifact-composition.server";
import { PrismaExperimentsRepository } from "#src/server/experiments/experiments.repositories.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";
import { sameOriginProxy } from "./helpers/same-origin-proxy";

/**
 * Documents in a conversation (task #385, the first batch; #514, their own page): a message
 * linking a document shows its card (title, first two lines); the card opens the document beside
 * the chat (Frank, 11-05), where edits save by themselves once typing rests, with no versions to
 * show; a save over text someone else changed in the same paragraph keeps the viewer's, asking
 * nothing;
 * what someone else saves elsewhere merges with what is being typed; closing saves what is left
 * first; a `?doc=` link opens it beside the chat; the Files tab lists the channel's documents,
 * and New document is created once typing rests, closed unwritten leaving nothing. Desktop and
 * phone, light and dark.
 *
 * Opt-in like the other browser E2Es: real local Web started as it is. The Documents experiment
 * is offered to every Workspace (task #491), so no flag file is needed; the run turns the
 * Workspace's switch on and puts it back. The channel, its people and its documents are seeded per
 * run and removed after it. Screenshots go under `.amp/e2e/artifact-documents/`.
 *
 * Every text a document gets carries the run's tail (task #525). Files are stored once per
 * content (sha256) and that record lives in the database, which every local worktree shares,
 * while the bytes live in the storage directory of the worktree that first wrote them: text an
 * earlier run in another worktree saved is found by its hash here but cannot be read, so the
 * card's lines and the document come back empty.
 */
const { origin: webOrigin, browserPath, databaseUrl } = localBrowserE2e();
const centrifugoOrigin = Bun.env.COFORGE_E2E_CENTRIFUGO_URL;
if (!centrifugoOrigin) throw new Error("COFORGE_E2E_CENTRIFUGO_URL is required");
const artifacts = join(import.meta.dir, "../../../.amp/e2e/artifact-documents");
const plan = (tail: string) =>
  [
    "# Goal",
    "",
    `Ship the new home page on November 15, saying clearly that people and Agents work together (run ${tail}).`,
    "",
    "# Timeline",
    "",
    "Week one design, week two build, week three test and ship.",
    "",
  ].join("\n");

test("a document opens beside the chat, saves by itself and keeps the viewer's text", async () => {
  // Centrifugo behind the page's own origin, so a version saved here reaches the page live.
  const proxy = sameOriginProxy(webOrigin, centrifugoOrigin);
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
  // The artifact beside the chat, saved or new.
  const pane = `(document.querySelector("main[aria-labelledby]") ?? document.querySelector('section[aria-label="Document"]'))`;
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
      text: plan(tail),
    });
    const notes = await documents.create(me, {
      conversationId: channel.id,
      title: "Weekly sync notes",
      text: `Progress, blockers and next week (run ${tail}).`,
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

    // Open: beside the chat, which stays; typing saves by itself once it rests.
    await click(`${card}.querySelector("a")`);
    await browser("wait", "--fn", `${pane}?.querySelector(".ProseMirror") != null`);
    expect(await evaluate<string>("location.pathname")).toEndWith(`/channel/${channel.id}`);
    expect(await evaluate<string | null>(`new URLSearchParams(location.search).get("doc")`)).toBe(
      doc.id,
    );
    expect(await evaluate<boolean>(`${card} !== null && ${card}.checkVisibility()`)).toBe(true);
    // No versions and no Save button: only the document.
    expect(await evaluate<boolean>(inPane("version"))).toBe(false);
    expect(await evaluate<boolean>(`${button("Save", pane)} == null`)).toBe(true);
    await editorEnd();
    await browser("keyboard", "type", " Owners: design coforge-ui.");
    await shoot("desktop-2-editing");
    await until(async () => (await version(doc.id)) === 2);
    expect((await documents.load(me, { artifactId: doc.id })).text).toContain("coforge-ui.");

    // Lin changes the timeline while nothing is unsaved: the pane takes it in, saying nothing.
    const linSaves = async (from: string, to: string) => {
      const latest = await version(doc.id);
      await documents.save(
        { workspaceId, actor: { userId: lin.id } },
        {
          artifactId: doc.id,
          baseVersion: latest,
          idempotencyKey: crypto.randomUUID(),
          text: (await documents.load(me, { artifactId: doc.id })).text.replace(from, to),
        },
      );
    };
    const editorText = `${pane}.querySelector(".ProseMirror").textContent`;
    await linSaves(
      "Week one design, week two build, week three test and ship.",
      "Nov 1–7 design (coforge-ui); Nov 8–14 build (builder); Nov 15 ship (Frank).",
    );
    await browser("wait", "--fn", `${editorText}.includes("Nov 1–7")`);
    expect(await evaluate<boolean>(inPane("published"))).toBe(false);

    // The viewer rewrites that paragraph while Lin changes it again, before the save goes:
    // nothing asks, and the viewer's text stays (Frank, 11-05: no co-editing to see).
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
    await linSaves("Nov 15 ship (Frank).", "Nov 15 test and ship (Frank).");
    await until(async () =>
      (await documents.load(me, { artifactId: doc.id })).text.includes("Week one design and copy"),
    );
    expect(await evaluate<boolean>(inPane("onflict"))).toBe(false);
    expect(await evaluate<boolean>(`${pane}.querySelector('input[type="radio"]') == null`)).toBe(
      true,
    );

    // Lin saves another paragraph while the viewer types: both stay, merged.
    await editorEnd();
    await browser("keyboard", "type", " Draft note.");
    await linSaves("# Goal", "# Goal (agreed)");
    await until(async () => {
      const text = (await documents.load(me, { artifactId: doc.id })).text;
      return text.includes("# Goal (agreed)") && text.includes("Draft note.");
    });
    await browser("wait", "--fn", `${editorText}.includes("Goal (agreed)")`);
    await shoot("desktop-5-page");

    // Closing with an edit not yet saved saves it on the way out, asking nothing.
    await editorEnd();
    await browser("keyboard", "type", " One more.");
    await click(`${pane}.querySelector('header button[aria-label="Close"]')`);
    await browser("wait", "--fn", `${pane} == null`);
    expect(await evaluate<boolean>(`document.querySelector('[role="dialog"]') == null`)).toBe(true);
    await until(async () =>
      (await documents.load(me, { artifactId: doc.id })).text.includes("One more."),
    );

    // A `?doc=` link opens the document beside the chat.
    await browser("open", `${page}?doc=${notes.id}`);
    await browser("wait", "--fn", `${pageHydrated} && ${inPane("Weekly sync notes")}`);
    expect(await evaluate<string>("location.pathname")).toEndWith(`/channel/${channel.id}`);

    // The Files tab: the channel's documents, newest first, and New document.
    await browser("open", `${page}?view=files`);
    await browser(
      "wait",
      "--fn",
      `${pageHydrated} && document.body.textContent.includes("Weekly sync notes")`,
    );
    await shoot("desktop-6-files");

    // New document is a draft until typing rests: closed unwritten, it leaves nothing.
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
    await browser("keyboard", "type", `Copy, images, analytics (run ${tail}).`);
    await until(async () => (await count()) === documentsBefore + 1);
    const draft = await db.artifact.findFirstOrThrow({
      where: { homeKey: `conversation:${channel.id}` },
      orderBy: { createdAt: "desc" },
    });
    // Created, it stays beside the chat as the document it now is, the caret still in its text.
    await browser(
      "wait",
      "--fn",
      `new URLSearchParams(location.search).get("doc") === "${draft.id}" && document.activeElement === ${pane}?.querySelector(".ProseMirror")`,
    );
    expect(draft.title).toBe("Launch checklist");
    expect((await documents.load(me, { artifactId: draft.id })).text).toContain("analytics");

    // The phone: the card, then the document over the chat.
    await browser("set", "viewport", "390", "844");
    await browser("open", `${page}?view=chat`);
    await browser("wait", "--fn", `${pageHydrated} && ${card} !== null`);
    await evaluate(`(${card}.scrollIntoView({ block: "center" }), true)`);
    await shoot("phone-1-card");
    await click(`${card}.querySelector("a")`);
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
