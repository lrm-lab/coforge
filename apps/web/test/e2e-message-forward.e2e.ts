import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { deleteAttachmentRows } from "#src/server/db/repositories/attachment-deletion.repositories.server";
import { LocalFileStorage } from "#src/server/files/file-storage.server";
import { browserSession, localBrowserE2e } from "./helpers/browser-e2e";
import { sameOriginProxy } from "./helpers/same-origin-proxy";

/**
 * Forwarding one message (task #237): from channel A, with an attachment, to channel B and a new
 * direct message with a note; the card in each destination and "Open source message" back; a
 * public channel the viewer has not joined, which asks before joining; and the phone's two steps.
 * Needs a local built Web with skip-auth, PostgreSQL, Redis, local Centrifugo, the Web's local file
 * storage directory (`COFORGE_FILE_STORAGE_DIR`) and agent-browser. No model runs. The suite
 * removes its own Workspace, writer and stored files. Screenshots live in .amp/e2e/message-forward/.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const centrifugoOrigin = Bun.env.COFORGE_E2E_CENTRIFUGO_URL;
if (!centrifugoOrigin || !["localhost", "127.0.0.1"].includes(new URL(centrifugoOrigin).hostname))
  throw new Error("COFORGE_E2E_CENTRIFUGO_URL must target local Centrifugo");
const storageRoot = Bun.env.COFORGE_FILE_STORAGE_DIR;
if (!storageRoot) throw new Error("COFORGE_FILE_STORAGE_DIR is required");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
const files = new LocalFileStorage(storageRoot);
const proxy = sameOriginProxy(origin, centrifugoOrigin);
const artifacts = join(import.meta.dir, "../../../.amp/e2e/message-forward");
const { browser, evaluate } = browserSession(browserPath, `message-forward-${process.pid}`);

const suffix = String(process.pid);
const channelA = `fwd-a-${suffix}`;
const channelB = `fwd-b-${suffix}`;
const channelC = `fwd-c-${suffix}`;
const writerName = `Forward writer ${suffix}`;
const fileName = `forward-${suffix}.txt`;
const note = `Please read ${suffix}`;
let workspaceId: string;
let workspaceSlug: string;
let writerId: string;
let ids: { a: string; b: string; c: string; source: string };
const objectKey = `e2e/forward/${suffix}/original`;

const click = (selector: string) => browser("click", selector);
const clickNamed = (role: string, name: string) =>
  browser("find", "role", role, "click", "--name", name);
const waitFor = (expression: string) => browser("wait", "--fn", expression);
const bodyIncludes = (text: string) =>
  `document.body.textContent.includes(${JSON.stringify(text)})`;
/** The row of a picker target: the checkbox's label wraps the whole row. */
const targetRow = (label: string) => `label:has(input[aria-label=${JSON.stringify(label)}])`;
const pageUrl = (path: string) => `${proxy.origin}/en/w/${workspaceSlug}/${path}`;

async function openForwardDialog(conversationId: string) {
  await browser("open", pageUrl(`channel/${conversationId}`));
  await waitFor(`document.querySelector('li[data-message-id="${ids.source}"]') !== null`);
  await browser("hover", `li[data-message-id="${ids.source}"]`);
  await click(`li[data-message-id="${ids.source}"] button[aria-label="More"]`);
  await clickNamed("menuitem", "Forward");
  await waitFor(
    `document.querySelector('[role="dialog"] input[placeholder="Search targets"]') !== null`,
  );
}

async function pick(search: string, label: string) {
  await browser("fill", 'input[placeholder="Search targets"]', search);
  await waitFor(`document.querySelector(${JSON.stringify(targetRow(label))}) !== null`);
  await click(targetRow(label));
}

/** A screenshot once no dialog is still fading in or out: one taken mid-fade shows the page
 * through it. */
async function shot(name: string) {
  await waitFor(`!document.querySelector("[data-entering], [data-exiting]")`);
  await browser("screenshot", join(artifacts, `${name}.png`));
}

beforeAll(async () => {
  await mkdir(artifacts, { recursive: true });
  await db.user.upsert({
    where: { id: DEV_BROWSER_USER.id },
    update: {},
    create: {
      id: DEV_BROWSER_USER.id,
      username: DEV_BROWSER_USER.username,
      displayName: "Forward reviewer",
      welcomedAt: new Date(),
    },
  });
  const writer = await db.user.create({
    data: { username: `fwd-writer-${suffix}`, displayName: writerName },
  });
  writerId = writer.id;
  const workspace = await db.workspace.create({
    data: {
      name: "Message forward",
      slug: `message-forward-${suffix}`,
      members: { create: [{ userId: DEV_BROWSER_USER.id, role: "owner" }, { userId: writerId }] },
    },
  });
  workspaceId = workspace.id;
  workspaceSlug = workspace.slug;
  const member = (userId: string) => ({ create: { userId } });
  const a = await db.conversation.create({
    data: { workspaceId, channelName: channelA, members: member(DEV_BROWSER_USER.id) },
    include: { members: true },
  });
  const b = await db.conversation.create({
    data: { workspaceId, channelName: channelB, members: member(DEV_BROWSER_USER.id) },
  });
  // Public, with only the writer in it: the viewer has not joined.
  const c = await db.conversation.create({
    data: { workspaceId, channelName: channelC, members: member(writerId) },
  });
  const source = await db.message.create({
    data: {
      workspaceId,
      conversationId: a.id,
      senderMemberId: a.members[0]!.id,
      sequence: 1,
      body: `Release notes draft ${suffix}\nsecond line`,
    },
  });
  await files.put(objectKey, new Blob(["Forwarded file body"]), "text/plain");
  await db.attachment.create({
    data: {
      workspaceId,
      conversationId: a.id,
      messageId: source.id,
      uploaderId: DEV_BROWSER_USER.id,
      objectKey,
      fileName,
      contentType: "text/plain",
      sizeBytes: 19,
    },
  });
  ids = { a: a.id, b: b.id, c: c.id, source: source.id };
});

afterAll(async () => {
  await browser("close");
  proxy.stop();
  if (workspaceId) {
    const stored = await db.attachment.findMany({ where: { workspaceId } });
    for (const conversation of await db.conversation.findMany({ where: { workspaceId } }))
      await deleteAttachmentRows(db, { conversationId: conversation.id });
    await db.workspace.delete({ where: { id: workspaceId } });
    for (const attachment of stored) await files.remove(attachment.objectKey);
  }
  if (writerId) await db.user.delete({ where: { id: writerId } });
  await db.$disconnect();
});

test("forwards a message with its attachment to a channel and a new DM, with a note", async () => {
  await browser("set", "viewport", "1440", "900");
  await openForwardDialog(ids.a);
  await shot("1440-dialog-empty");
  await pick(channelB, `#${channelB}`);
  await pick(writerName, `@${writerName}`);
  await browser("fill", '[role="dialog"] textarea', note);
  await waitFor(`${bodyIncludes("2 selected")}`);
  await shot("1440-dialog-selected");
  await click('button[aria-label="Send forward"]');
  await waitFor(bodyIncludes("Forwarded to 2 destinations"));
  await shot("1440-toast");

  // "View in Chat" goes to the first destination, channel B.
  // The toast slides in; a pointer click lands where its button was a moment ago.
  await browser(
    "eval",
    `[...document.querySelectorAll("[data-sonner-toast] button")].find((b) => b.textContent.trim() === "View in Chat").click()`,
  );
  await waitFor(`location.pathname.endsWith("/channel/${ids.b}")`);
  await waitFor(`document.querySelector("[data-forwarded-card]") !== null`);
  const card = await evaluate<{ text: string; row: string }>(
    `(() => { const card = document.querySelector("[data-forwarded-card]"); return { text: card.textContent, row: card.closest("li").textContent }; })()`,
  );
  expect(card.text).toContain(`from #${channelA}`);
  expect(card.text).toContain(`Release notes draft ${suffix}`);
  expect(card.text).toContain(fileName);
  expect(card.row).toContain(note);
  await shot("1440-card-channel");

  const dm = await db.conversation.findFirstOrThrow({
    // The new DM with the writer, not the Workspace assistant's, which every Workspace has.
    where: {
      workspaceId,
      directKey: { not: null },
      messages: { some: { forward: { isNot: null } } },
    },
  });
  await browser("open", pageUrl(`dm/${dm.id}`));
  await waitFor(`document.querySelector("[data-forwarded-card]") !== null`);
  await shot("1440-card-dm");
  const copies = await db.attachment.count({
    where: { conversationId: { in: [ids.b, dm.id] }, fileName },
  });
  expect(copies).toBe(2);
}, 120_000);

test("Open source message goes back to the original", async () => {
  await browser("open", pageUrl(`channel/${ids.b}`));
  await waitFor(`document.querySelector("[data-forwarded-card]") !== null`);
  await clickNamed("link", "Open source message");
  await waitFor(`location.pathname.endsWith("/channel/${ids.a}")`);
  await waitFor(`document.querySelector('li[data-message-id="${ids.source}"]') !== null`);
  await shot("1440-source");
}, 60_000);

test("a channel the viewer has not joined asks first, then joins and forwards", async () => {
  await openForwardDialog(ids.a);
  await pick(channelC, `#${channelC}`);
  await waitFor(bodyIncludes("Not joined"));
  await click('button[aria-label="Send forward"]');
  await waitFor(
    bodyIncludes(`You haven't joined #${channelC}. Forwarding will join the channel first.`),
  );
  await shot("1440-join-warning");
  // The warning alone changed nothing.
  expect(
    await db.conversationMember.count({
      where: { conversationId: ids.c, userId: DEV_BROWSER_USER.id },
    }),
  ).toBe(0);
  expect(await db.message.count({ where: { conversationId: ids.c } })).toBe(0);
  await click('button[aria-label="Send forward"]');
  await waitFor(bodyIncludes(`Forwarded to #${channelC}.`));
  expect(
    await db.conversationMember.count({
      where: { conversationId: ids.c, userId: DEV_BROWSER_USER.id, leftAt: null },
    }),
  ).toBe(1);
  expect(await db.messageForward.count({ where: { message: { conversationId: ids.c } } })).toBe(1);
}, 90_000);

test("on a phone the targets and the note are two steps", async () => {
  await browser("set", "viewport", "390", "844");
  await browser("open", pageUrl(`channel/${ids.b}`));
  await waitFor(`document.querySelector("[data-forwarded-card]") !== null`);
  await shot("390-card");
  await browser("open", pageUrl(`channel/${ids.a}`));
  await waitFor(`document.querySelector('li[data-message-id="${ids.source}"]') !== null`);
  // A tap on the row's text opens the action sheet.
  await click(`li[data-message-id="${ids.source}"] [data-scroll-anchor]`);
  await waitFor(`document.querySelector("[data-message-actions-popover]") !== null`);
  await shot("390-sheet");
  await browser(
    "eval",
    `[...document.querySelectorAll("[data-message-actions-popover] button")].find((b) => b.textContent.trim() === "Forward").click()`,
  );
  await waitFor(
    `document.querySelector('[role="dialog"] input[placeholder="Search targets"]') !== null`,
  );
  await shot("390-destinations");
  await pick(channelB, `#${channelB}`);
  await clickNamed("button", "Add a note");
  await waitFor(`document.querySelector('[role="dialog"] textarea') !== null`);
  await shot("390-note");
  await clickNamed("button", "Back to destinations");
  await waitFor(
    `document.querySelector('[role="dialog"] input[placeholder="Search targets"]')?.offsetParent !== null`,
  );
  await browser("press", "Escape");
}, 90_000);
