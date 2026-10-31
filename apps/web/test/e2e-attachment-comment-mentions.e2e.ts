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
 * Mentioning people in a file's comments, and opening a comment from Activity, in a real browser.
 *
 * - The comment field's `@` lists the members of the conversation the file is in (a channel's
 *   people, never the viewer or someone outside it), the line above it says whom the comment
 *   will notify, choosing one keeps who was meant with the
 *   draft across a reload, and sending stores a real mention of them and notifies them
 *   (`pending_mention_actions`, read back from the database); the comment then shows the person's
 *   name, not its stored token.
 * - A comment a member posts to the viewer is an Activity item: clicking it opens the file's
 *   conversation at its message and the file's review at the comments, scrolled to and marked on
 *   that comment, with `file` and `comment` in the address. A reload, and the same address in
 *   Chat on a phone, reopen it straight at the comments; closing the review takes both off the
 *   address without adding a history entry.
 *
 * Opt-in like the other browser E2Es: real local Web (`COFORGE_DEV_SKIP_AUTH=1`, a seeded
 * database), `agent-browser`, local PostgreSQL, and `COFORGE_FILE_STORAGE_DIR` (the Web service's
 * file storage). Everything it writes lives in a Workspace of its own that it deletes afterwards.
 * Screenshots are written under `.amp/e2e/attachment-comment-mentions/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const storageRoot = Bun.env.COFORGE_FILE_STORAGE_DIR;
if (!storageRoot) throw new Error("COFORGE_FILE_STORAGE_DIR is required");
const artifacts = join(import.meta.dir, "../../../.amp/e2e/attachment-comment-mentions");

test("a file's comment mentions a member of its conversation, and Activity opens a comment at its place", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const files = new LocalFileStorage(storageRoot);
  const { browser, evaluate } = browserSession(
    browserPath,
    `attachment-comment-mentions-${process.pid}`,
  );
  const suffix = String(process.pid);
  const slug = `e2e-comment-mentions-${suffix}`;
  const fileName = `review-${suffix}.txt`;
  const objectKey = `e2e/comment-mentions/${suffix}/original`;
  const workspacePath = `/en/w/${slug}`;
  const dialogField = '[role="dialog"] textarea';
  const listbox = `document.querySelector('[role="listbox"]')`;
  const listText = `(${listbox}?.textContent ?? "")`;
  const fieldValue = `document.querySelector('[role="dialog"] textarea')?.value`;
  /** Resolves once `read` answers, so a check waits for the row a send commits. */
  async function until<T>(what: string, read: () => Promise<T | null | undefined>) {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const found = await read();
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await Bun.sleep(250);
    }
  }
  const [peer, outsider] = await Promise.all(
    [
      ["peer", "Comment Peer"],
      ["outsider", "Comment Outsider"],
    ].map(([username, displayName]) =>
      db.user.create({ data: { username: `e2e-comment-${username}-${suffix}`, displayName } }),
    ),
  );
  const workspace = await new PrismaWorkspaceCatalogStore(db).createForUser({
    slug,
    name: "E2E comment mentions",
    userId: DEV_BROWSER_USER.id,
  });
  let conversationId = "";
  try {
    for (const user of [peer!, outsider!])
      await db.workspaceMembership.create({
        data: { workspaceId: workspace.id, userId: user.id },
      });
    // A channel of the viewer and the peer alone: the outsider is in the Workspace, not in it.
    const channel = await db.conversation.create({
      data: {
        workspaceId: workspace.id,
        channelName: `comment-mentions-${suffix}`,
        members: {
          create: [DEV_BROWSER_USER.id, peer!.id].map((userId) => ({
            userId,
          })),
        },
      },
      include: { members: true },
    });
    conversationId = channel.id;
    const message = await db.message.create({
      data: {
        workspaceId: workspace.id,
        conversationId,
        senderMemberId: channel.members.find((row) => row.userId === DEV_BROWSER_USER.id)!.id,
        body: "Please review this attachment",
        sequence: 1,
      },
    });
    await files.put(objectKey, new Blob(["File under review"]), "text/plain");
    const attachment = await db.attachment.create({
      data: {
        workspaceId: workspace.id,
        conversationId,
        messageId: message.id,
        uploaderId: DEV_BROWSER_USER.id,
        objectKey,
        fileName,
        contentType: "text/plain",
        sizeBytes: 17,
      },
    });
    await mkdir(artifacts, { recursive: true });
    const preview = `button[aria-label="Preview ${fileName}"]`;
    /** Opens the file's comments: from its card, or, after a reload, in the review the address
     * reopened. */
    const openComments = async (reopened = false) => {
      await browser(
        "wait",
        "--fn",
        `${pageHydrated} && Boolean(document.querySelector('${preview}'))`,
      );
      if (!reopened) await browser("click", preview);
      // A text preview is read before the dialog opens; a click while it animates in is lost.
      await browser(
        "wait",
        "--fn",
        `(() => { const dialog = document.querySelector('[role="dialog"]'); return Boolean(dialog?.querySelector('button[aria-label="Comments"]') && !dialog.closest("[data-entering]")); })()`,
      );
      await browser("click", '[role="dialog"] button[aria-label="Comments"]');
      // The field takes names once the comments, and with them whether one may comment, are read.
      await browser(
        "wait",
        "--fn",
        `Boolean(document.querySelector('${dialogField}:not([disabled])')) && !document.querySelector('[role="dialog"]').textContent.includes("Loading comments")`,
      );
    };

    // 1. `@` in the comment field lists the channel's other member, and no one else. Above the
    // field, whom the comment will notify: no one yet, as the viewer uploaded the file.
    const dialogText = `document.querySelector('[role="dialog"]').textContent`;
    await browser("set", "viewport", "1440", "900");
    await browser("open", `${origin}${workspacePath}/channel/${conversationId}`);
    await openComments();
    // Opening the file by hand puts it, and the message it is in, in the address.
    expect(
      await evaluate<Record<string, string | null>>(`(() => {
        const search = new URLSearchParams(location.search);
        return { file: search.get("file"), message: search.get("message") };
      })()`),
    ).toEqual({ file: attachment.id, message: message.id });
    await browser("wait", "--fn", `${dialogText}.includes("Won't notify anyone.")`);
    await browser("screenshot", join(artifacts, "0-no-comments.png"));
    await browser("focus", dialogField);
    await browser("keyboard", "type", "@");
    await browser("keyboard", "type", "Comment");
    await browser("wait", "--fn", `${listText}.includes("Comment Peer")`);
    expect(await evaluate<string>(listText)).not.toContain("Comment Outsider");
    await browser("screenshot", join(artifacts, "1-list-of-members.png"));
    // Choosing writes the name; the draft keeps who was meant across a reload.
    await browser("press", "Enter");
    await browser("wait", "--fn", `${fieldValue} === "@Comment Peer "`);
    await browser("wait", "--fn", `${dialogText}.includes("Will notify: Comment Peer")`);
    await browser("keyboard", "inserttext", "please check");
    await browser("screenshot", join(artifacts, "1-will-notify.png"));
    await browser("reload");
    await openComments(true);
    await browser("wait", "--fn", `${fieldValue} === "@Comment Peer please check"`);
    await browser("wait", "--fn", `${dialogText}.includes("Will notify: Comment Peer")`);

    // 2. Sending stores a real mention of the person and notifies them.
    await browser("focus", dialogField);
    await browser("press", "Enter");
    const posted = await until("the posted comment", () =>
      db.message.findFirst({
        where: {
          workspaceId: workspace.id,
          attachmentComment: { attachmentId: attachment.id },
          sender: { userId: DEV_BROWSER_USER.id },
        },
        include: { mentions: true },
      }),
    );
    expect(posted.body).toBe(`<@human:${peer!.id}> please check`);
    expect(posted.mentions.map((mention) => [mention.kind, mention.actorId])).toEqual([
      ["user", peer!.id],
    ]);
    const notified = await db.pendingMentionAction.findMany({ where: { messageId: posted.id } });
    expect(notified.map((row) => [row.targetUserId, row.reason])).toEqual([
      [peer!.id, "mentioned"],
    ]);
    // The row reads the person by name, never as the stored token.
    await browser(
      "wait",
      "--fn",
      `document.querySelector('[role="dialog"] [data-comment-id="${posted.id}"]')?.textContent.includes("Comment Peer")`,
    );
    expect(
      await evaluate<boolean>(
        `document.querySelector('[role="dialog"] [data-comment-id="${posted.id}"]').textContent.includes("<@")`,
      ),
    ).toBe(false);
    await browser("screenshot", join(artifacts, "2-comment-with-mention.png"));
    await browser("press", "Escape");
    await browser("wait", "--fn", `!document.querySelector('[role="dialog"]')`);

    // 3. The peer comments on the viewer: ten earlier comments, then one that mentions them, then
    // four more, so the one an Activity item opens at is below the fold of the comments panel.
    const comments = new AttachmentComments(new PrismaAttachmentCommentStore(db));
    const peerActor = { workspaceId: workspace.id, userId: peer!.id };
    const post = (body: string, mention = false) =>
      comments.post(peerActor, {
        attachmentId: attachment.id,
        body,
        ...(mention
          ? {
              mentions: [
                { type: "user" as const, id: DEV_BROWSER_USER.id, name: DEV_BROWSER_USER.username },
              ],
            }
          : {}),
      });
    for (let index = 1; index <= 10; index += 1) await post(`Earlier remark ${index}`);
    const targetBody = `@${DEV_BROWSER_USER.username} Mention target ${suffix}`;
    const target = await post(targetBody, true);
    for (let index = 1; index <= 4; index += 1) await post(`Later remark ${index}`);

    const row = `[...document.querySelectorAll(${rowItems})].find((item) => item.textContent.includes("Mention target ${suffix}"))`;
    // The comment is in view, inside its panel, and marked as a jump marks it.
    const reached = `(() => { const row = document.querySelector('[role="dialog"] [data-comment-id="${target.id}"]'); const box = row?.getBoundingClientRect(); const list = row?.closest('[aria-live="polite"]')?.getBoundingClientRect(); return Boolean(box && list && box.top >= list.top && box.bottom <= list.bottom && row.className.includes("bg-tertiary")); })()`;
    await browser("set", "viewport", "1440", "560");
    await browser("open", `${origin}${workspacePath}/activity`);
    await browser("wait", "--fn", `${pageHydrated} && Boolean(${row})`);
    await evaluate(`${row}.querySelector("a").click() ?? true`);
    // The conversation opens beside the list at the file's message, with the file's review over it.
    await browser("wait", "--fn", inPane(message.id));
    await browser("wait", "--fn", reached);
    const address = await evaluate<Record<string, string | null>>(`(() => {
      const search = new URLSearchParams(location.search);
      return { path: location.pathname, open: search.get("open"), file: search.get("file"), comment: search.get("comment") };
    })()`);
    expect(address).toEqual({
      path: `${workspacePath}/activity`,
      open: `channel:${conversationId}`,
      file: attachment.id,
      comment: target.id,
    });
    await browser("screenshot", join(artifacts, "3-activity-opens-comment.png"));

    // 4. A reload reopens the review at the same comment.
    await browser("reload");
    await browser("wait", "--fn", reached);

    // 5. Closing the review takes both off the address and replaces the entry.
    const entries = await evaluate<number>("history.length");
    await browser("press", "Escape");
    await browser("wait", "--fn", `!document.querySelector('[role="dialog"]')`);
    await browser(
      "wait",
      "--fn",
      `!location.search.includes("file=") && !location.search.includes("comment=")`,
    );
    expect(await evaluate<number>("history.length")).toBe(entries);
    expect(await evaluate<string | null>(`new URLSearchParams(location.search).get("open")`)).toBe(
      `channel:${conversationId}`,
    );

    // 6. The same address in Chat, on a phone, opens straight into the comments.
    await browser("set", "viewport", "390", "844");
    await browser(
      "open",
      `${origin}${workspacePath}/channel/${conversationId}?file=${attachment.id}&comment=${target.id}`,
    );
    await browser("wait", "--fn", reached);
    expect(
      await evaluate<boolean>(
        `document.querySelector('${dialogField}').getClientRects().length > 0`,
      ),
    ).toBe(true);
    // Taken once the dialog has finished opening over the page.
    await browser("wait", "--fn", `!document.querySelector("[data-entering]")`);
    await browser("screenshot", join(artifacts, "4-phone-comments.png"));
    await browser("press", "Escape");
    await browser(
      "wait",
      "--fn",
      `!document.querySelector('[role="dialog"]') && !location.search.includes("file=")`,
    );
  } catch (failure) {
    // What the page looked like when it went wrong.
    await browser("screenshot", join(artifacts, "failure.png")).catch(() => undefined);
    throw failure;
  } finally {
    await deleteAttachmentRows(db, { conversationId }).catch(() => {});
    await db.message.deleteMany({ where: { workspaceId: workspace.id } }).catch(() => {});
    await db.workspace.delete({ where: { id: workspace.id } }).catch(() => {});
    await db.user.deleteMany({ where: { id: { in: [peer!.id, outsider!.id] } } }).catch(() => {});
    await files.remove(objectKey).catch(() => {});
    await browser("close").catch(() => undefined);
    await db.$disconnect();
  }
}, 300_000);
