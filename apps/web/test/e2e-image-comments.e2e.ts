import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { AttachmentComments } from "#src/server/attachments/attachment-comments.server";
import { deleteAttachmentRows } from "#src/server/db/repositories/attachment-deletion.repositories.server";
import { PrismaAttachmentCommentStore } from "#src/server/db/repositories/attachment-comments.repositories.server";
import { LocalFileStorage } from "#src/server/files/file-storage.server";
import { PrismaWorkspaceCatalogStore } from "#src/server/workspaces/catalog.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";
import { inPane, rowItems } from "./helpers/activity-inbox-e2e";

/**
 * An image's comments, in a real browser: the image's lightbox has the comments button every
 * file's review has, and the same panel beside it, where a comment is posted. A comment a member
 * posts on it is an Activity item that opens the image at that comment; the same address in Chat
 * on a phone opens straight into its comments, and closing takes it off the address.
 *
 * Opt-in like the other browser E2Es: real local Web (`COFORGE_DEV_SKIP_AUTH=1`, a seeded
 * database), `agent-browser`, local PostgreSQL, and `COFORGE_FILE_STORAGE_DIR` (the Web service's
 * file storage). Everything it writes lives in a Workspace of its own that it deletes afterwards.
 * Screenshots are written under `.amp/e2e/image-comments/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const storageRoot = Bun.env.COFORGE_FILE_STORAGE_DIR;
if (!storageRoot) throw new Error("COFORGE_FILE_STORAGE_DIR is required");
const artifacts = join(import.meta.dir, "../../../.amp/e2e/image-comments");
const image = join(import.meta.dir, "../public/apple-touch-icon.png");

test("an image takes comments in its lightbox, and a link into one opens it there", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const files = new LocalFileStorage(storageRoot);
  const { browser, evaluate } = browserSession(browserPath, `image-comments-${process.pid}`);
  const suffix = String(process.pid);
  const slug = `e2e-image-comments-${suffix}`;
  const fileName = `chart-${suffix}.png`;
  const objectKey = `e2e/image-comments/${suffix}/original`;
  const workspacePath = `/en/w/${slug}`;
  const dialogField = '[role="dialog"] textarea';
  async function until<T>(what: string, read: () => Promise<T | null | undefined>) {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const found = await read();
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await Bun.sleep(250);
    }
  }
  const peer = await db.user.create({
    data: { username: `e2e-image-peer-${suffix}`, displayName: "Image Peer" },
  });
  const workspace = await new PrismaWorkspaceCatalogStore(db).createForUser({
    slug,
    name: "E2E image comments",
    userId: DEV_BROWSER_USER.id,
  });
  let conversationId = "";
  try {
    await db.workspaceMembership.create({ data: { workspaceId: workspace.id, userId: peer.id } });
    const channel = await db.conversation.create({
      data: {
        workspaceId: workspace.id,
        channelName: `image-comments-${suffix}`,
        members: { create: [DEV_BROWSER_USER.id, peer.id].map((userId) => ({ userId })) },
      },
      include: { members: true },
    });
    conversationId = channel.id;
    const message = await db.message.create({
      data: {
        workspaceId: workspace.id,
        conversationId,
        senderMemberId: channel.members.find((row) => row.userId === DEV_BROWSER_USER.id)!.id,
        body: "The chart for review",
        sequence: 1,
      },
    });
    const bytes = await Bun.file(image).arrayBuffer();
    await files.put(objectKey, new Blob([bytes]), "image/png");
    const attachment = await db.attachment.create({
      data: {
        workspaceId: workspace.id,
        conversationId,
        messageId: message.id,
        uploaderId: DEV_BROWSER_USER.id,
        objectKey,
        fileName,
        contentType: "image/png",
        sizeBytes: bytes.byteLength,
      },
    });
    await mkdir(artifacts, { recursive: true });
    const commentsButton = '[role="dialog"] button[aria-label="Comments"]';
    const fieldReady = `Boolean(document.querySelector('${dialogField}:not([disabled])')) && !document.querySelector('[role="dialog"]').textContent.includes("Loading comments")`;

    // 1. The image's lightbox has the comments button; the panel opens beside it and takes one.
    await browser("set", "viewport", "1440", "900");
    await browser("open", `${origin}${workspacePath}/channel/${conversationId}`);
    const thumbnail = `button[aria-label="${fileName}"]`;
    await browser(
      "wait",
      "--fn",
      `${pageHydrated} && Boolean(document.querySelector('${thumbnail}'))`,
    );
    await browser("click", thumbnail);
    await browser(
      "wait",
      "--fn",
      `(() => { const dialog = document.querySelector('[role="dialog"]'); return Boolean(dialog?.querySelector('button[aria-label="Comments"]') && !dialog.closest("[data-entering]")); })()`,
    );
    // The image shown is in the address, with the message it is in: a reload opens it again, on
    // the image alone, as the address names no comment.
    expect(
      await evaluate<Record<string, string | null>>(`(() => {
        const search = new URLSearchParams(location.search);
        return { file: search.get("file"), message: search.get("message") };
      })()`),
    ).toEqual({ file: attachment.id, message: message.id });
    await browser("reload");
    await browser(
      "wait",
      "--fn",
      `${pageHydrated} && (() => { const dialog = document.querySelector('[role="dialog"]'); return Boolean(dialog?.querySelector('img[alt="${fileName}"]') && !dialog.closest("[data-entering]")); })()`,
    );
    await browser("click", commentsButton);
    await browser("wait", "--fn", fieldReady);
    // Beside the comments the image is on the review's own, opaque background.
    expect(
      await evaluate<string>(
        `getComputedStyle(document.querySelector('[role="dialog"] img[alt="${fileName}"]').closest(".bg-secondary")).backgroundColor`,
      ),
    ).not.toMatch(/rgba\(.*, 0\)|transparent/);
    await browser("focus", dialogField);
    await browser("keyboard", "inserttext", "The legend is cut off");
    await browser("press", "Enter");
    const mine = await until("the viewer's comment", () =>
      db.message.findFirst({
        where: {
          attachmentComment: { attachmentId: attachment.id },
          body: "The legend is cut off",
        },
      }),
    );
    await browser(
      "wait",
      "--fn",
      `Boolean(document.querySelector('[role="dialog"] [data-comment-id="${mine.id}"]'))`,
    );
    // The image keeps its place beside the panel.
    expect(
      await evaluate<boolean>(
        `document.querySelector('[role="dialog"] img[alt="${fileName}"]').getClientRects().length > 0`,
      ),
    ).toBe(true);
    await browser("screenshot", join(artifacts, "1-desktop-image-comments.png"));
    await browser("press", "Escape");
    await browser("wait", "--fn", `!document.querySelector('[role="dialog"]')`);

    // 2. The peer replies; the viewer, as the uploader, gets an Activity item that opens the image
    // at that comment, with the image and comment in the address.
    const reply = await new AttachmentComments(new PrismaAttachmentCommentStore(db)).post(
      { workspaceId: workspace.id, userId: peer.id },
      { attachmentId: attachment.id, body: `Fixed in the next export ${suffix}` },
    );
    const reached = `Boolean(document.querySelector('[role="dialog"] [data-comment-id="${reply.id}"]')?.className.includes("bg-tertiary"))`;
    const row = `[...document.querySelectorAll(${rowItems})].find((item) => item.textContent.includes("Fixed in the next export ${suffix}"))`;
    await browser("open", `${origin}${workspacePath}/activity`);
    await browser("wait", "--fn", `${pageHydrated} && Boolean(${row})`);
    // A real click, as a reader's: a scripted one is a virtual press, which defers the dialog's focus.
    await evaluate(`${row}.querySelector("a").setAttribute("data-e2e-open", "") ?? true`);
    await browser("click", "[data-e2e-open]");
    await browser("wait", "--fn", inPane(message.id));
    await browser("wait", "--fn", reached);
    expect(
      await evaluate<Record<string, string | null>>(`(() => {
        const search = new URLSearchParams(location.search);
        return { file: search.get("file"), comment: search.get("comment") };
      })()`),
    ).toEqual({ file: attachment.id, comment: reply.id });
    await browser("screenshot", join(artifacts, "2-activity-opens-image-comment.png"));

    // 3. Closing takes the image and comment off the address.
    await browser("press", "Escape");
    await browser(
      "wait",
      "--fn",
      `!document.querySelector('[role="dialog"]') && !location.search.includes("file=") && !location.search.includes("comment=")`,
    );

    // 4. The same address in Chat, on a phone, opens straight into the image's comments.
    await browser("set", "viewport", "390", "844");
    await browser(
      "open",
      `${origin}${workspacePath}/channel/${conversationId}?file=${attachment.id}&comment=${reply.id}`,
    );
    await browser("wait", "--fn", reached);
    expect(
      await evaluate<boolean>(
        `document.querySelector('${dialogField}').getClientRects().length > 0 && (document.querySelector('[role="dialog"] img[alt="${fileName}"]')?.getClientRects().length ?? 0) === 0`,
      ),
    ).toBe(true);
    await browser("wait", "--fn", `!document.querySelector("[data-entering]")`);
    await browser("screenshot", join(artifacts, "3-phone-image-comments.png"));
    // The comments button takes the reader back to the image.
    await browser("click", commentsButton);
    await browser(
      "wait",
      "--fn",
      `document.querySelector('[role="dialog"] img[alt="${fileName}"]')?.getClientRects().length > 0`,
    );
    await browser("press", "Escape");
    await browser(
      "wait",
      "--fn",
      `!document.querySelector('[role="dialog"]') && !location.search.includes("file=")`,
    );
  } catch (failure) {
    await browser("screenshot", join(artifacts, "failure.png")).catch(() => undefined);
    throw failure;
  } finally {
    await deleteAttachmentRows(db, { conversationId }).catch(() => {});
    await db.message.deleteMany({ where: { workspaceId: workspace.id } }).catch(() => {});
    await db.workspace.delete({ where: { id: workspace.id } }).catch(() => {});
    await db.user.delete({ where: { id: peer.id } }).catch(() => {});
    await files.remove(objectKey).catch(() => {});
    await browser("close").catch(() => undefined);
    await db.$disconnect();
  }
}, 300_000);
