import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { deleteAttachmentRows } from "#src/server/db/repositories/attachment-deletion.repositories.server";
import { PrismaWorkspaceCatalogStore } from "#src/server/workspaces/catalog.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";

const { origin, browserPath, databaseUrl } = localBrowserE2e();
const field = "textarea[placeholder]";
const sendButton = `form:has(${field}) button[type="submit"]`;
const waitingHint = `form:has(${field}) [data-composer-send-waiting]`;
const holdUploads = `(() => {
  if (window.__heldUploads) return true;
  window.__heldUploads = [];
  const open = XMLHttpRequest.prototype.open;
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__url = String(url);
    return open.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (body) {
    if (!this.__url?.endsWith("/api/attachments")) return send.call(this, body);
    window.__heldUploads.push({ release: () => send.call(this, body), fail: () => this.dispatchEvent(new ProgressEvent("error")) });
  };
  return true;
})()`;
const heldUploads = `window.__heldUploads.length`;
const releaseUploads = `window.__heldUploads.splice(0).forEach((upload) => upload.release()) ?? true`;
const failFirstUpload = `(() => { const first = window.__heldUploads.shift(); if (first) first.fail(); return Boolean(first); })()`;
const draft = `document.querySelector('${field}').value`;
const trayHas = (name: string) =>
  `document.querySelector('form:has(${field})').innerText.includes(${JSON.stringify(name)})`;

test("a send pressed while uploading sends once, cancels on partial failure, manual removal, or switching drafts", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `send-during-upload-${process.pid}`);
  const suffix = String(process.pid);
  const slug = `e2e-send-during-upload-${suffix}`;
  const workspace = await new PrismaWorkspaceCatalogStore(db).createForUser({
    slug,
    name: "E2E send during upload",
    userId: DEV_BROWSER_USER.id,
  });
  const files: string[] = [];
  let channelAId = "";
  let channelBId = "";
  try {
    const channelA = await db.conversation.create({
      data: {
        workspaceId: workspace.id,
        channelName: `upload-a-${suffix}`,
        members: { create: [{ userId: DEV_BROWSER_USER.id }] },
      },
    });
    const channelB = await db.conversation.create({
      data: {
        workspaceId: workspace.id,
        channelName: `upload-b-${suffix}`,
        members: { create: [{ userId: DEV_BROWSER_USER.id }] },
      },
    });
    channelAId = channelA.id;
    channelBId = channelB.id;
    const messagesIn = (conversationId: string) =>
      db.message.findMany({
        where: { conversationId },
        orderBy: { sequence: "asc" },
        include: { attachments: { orderBy: { createdAt: "asc" } } },
      });
    const waitForMessages = async (conversationId: string, count: number) => {
      const deadline = Date.now() + 30_000;
      for (;;) {
        const found = await messagesIn(conversationId);
        if (found.length >= count) return found;
        if (Date.now() > deadline)
          throw new Error(`waited for ${count} messages, saw ${found.length}`);
        await Bun.sleep(200);
      }
    };
    const note = async (name: string) => {
      const filePath = `${Bun.env.TMPDIR ?? "/tmp"}/${name}`;
      await Bun.write(filePath, `${name}\n`);
      files.push(filePath);
      return filePath;
    };

    await browser("set", "viewport", "1440", "900");
    await browser("open", `${origin}/en/w/${slug}/channel/${channelBId}`);
    await browser("wait", "--fn", `${pageHydrated} && document.querySelector('${field}') !== null`);
    await browser("fill", field, "Saved draft in channel B.");
    await Bun.sleep(400);

    await browser("click", `a[href*="/channel/${channelAId}"]`);
    await browser(
      "wait",
      "--fn",
      `location.pathname.includes("/channel/${channelAId}") && (document.querySelector('${field}')?.getAttribute("placeholder") ?? "").includes("upload-a-${suffix}") && ${draft} === ""`,
    );
    expect(await evaluate<boolean>(holdUploads)).toBe(true);

    const keptName = `kept-${suffix}.txt`;
    await browser("upload", 'input[type="file"]', await note(keptName));
    await browser("wait", "--fn", `${heldUploads} === 1 && ${trayHas(keptName)}`);
    expect(await evaluate<boolean>(`!document.querySelector('${sendButton}')?.disabled`)).toBe(
      true,
    );
    await browser("fill", field, "Notes are attached.");
    await browser("wait", "--fn", `${draft} === "Notes are attached."`);
    await browser("click", field);
    await browser("wait", "--fn", `document.activeElement === document.querySelector('${field}')`);
    await browser("press", "Enter");
    await browser("wait", "--fn", `Boolean(document.querySelector('${waitingHint}'))`);
    expect(
      await evaluate<string>(`document.querySelector('${waitingHint}')?.textContent ?? ""`),
    ).toContain("Will send once upload finishes");

    await browser("press", "Enter");
    await Bun.sleep(500);
    expect(await messagesIn(channelAId)).toHaveLength(0);

    expect(await evaluate<boolean>(releaseUploads)).toBe(true);
    const [sent] = await waitForMessages(channelAId, 1);
    expect(sent!.body).toBe("Notes are attached.");
    expect(sent!.attachments.map((attachment) => attachment.fileName)).toEqual([keptName]);
    await browser(
      "wait",
      "--fn",
      `${draft} === "" && !${trayHas(keptName)} && !document.querySelector('${waitingHint}')`,
    );
    await Bun.sleep(600);
    expect(await messagesIn(channelAId)).toHaveLength(1);

    const failFirst = `fail-first-${suffix}.txt`;
    const keepSecond = `keep-second-${suffix}.txt`;
    await browser("upload", 'input[type="file"]', await note(failFirst), await note(keepSecond));
    await browser(
      "wait",
      "--fn",
      `${heldUploads} === 1 && ${trayHas(failFirst)} && ${trayHas(keepSecond)}`,
    );
    await browser("fill", field, "Two files where first fails.");
    await browser("click", sendButton);
    await browser("wait", "--fn", `Boolean(document.querySelector('${waitingHint}'))`);
    expect(await evaluate<boolean>(failFirstUpload)).toBe(true);
    await browser("wait", "--fn", `!document.querySelector('${waitingHint}')`);
    await browser("wait", "--fn", `${heldUploads} === 1`);
    expect(await evaluate<boolean>(releaseUploads)).toBe(true);
    await Bun.sleep(800);
    expect(await messagesIn(channelAId)).toHaveLength(1);
    expect(await evaluate<string>(draft)).toBe("Two files where first fails.");

    await evaluate(
      `(() => { [...document.querySelectorAll('form:has(${field}) button[aria-label*="Remove"]')].forEach((btn) => btn.click()); return true; })()`,
    );
    await browser("wait", "--fn", `!${trayHas(failFirst)} && !${trayHas(keepSecond)}`);
    await Bun.sleep(500);
    expect(await messagesIn(channelAId)).toHaveLength(1);

    const removedName = `removed-${suffix}.txt`;
    await browser("upload", 'input[type="file"]', await note(removedName));
    await browser("wait", "--fn", `${heldUploads} === 1 && ${trayHas(removedName)}`);
    await browser("fill", field, "Manual removal cancels wait.");
    await browser("click", sendButton);
    await browser("wait", "--fn", `Boolean(document.querySelector('${waitingHint}'))`);
    await evaluate(
      `(() => { document.querySelector('form:has(${field}) button[aria-label*="Remove"]')?.click(); return true; })()`,
    );
    await browser(
      "wait",
      "--fn",
      `!${trayHas(removedName)} && !document.querySelector('${waitingHint}')`,
    );
    expect(await evaluate<boolean>(releaseUploads)).toBe(true);
    await Bun.sleep(600);
    expect(await messagesIn(channelAId)).toHaveLength(1);
    expect(await evaluate<string>(draft)).toBe("Manual removal cancels wait.");

    const switchName = `switch-${suffix}.txt`;
    await browser("upload", 'input[type="file"]', await note(switchName));
    await browser("wait", "--fn", `${heldUploads} === 1 && ${trayHas(switchName)}`);
    await browser("fill", field, "Queued in A before switching to B.");
    await browser("click", sendButton);
    await browser("wait", "--fn", `Boolean(document.querySelector('${waitingHint}'))`);
    await browser("click", `a[href*="/channel/${channelBId}"]`);
    await browser(
      "wait",
      "--fn",
      `location.pathname.includes("/channel/${channelBId}") && ${draft} === "Saved draft in channel B."`,
    );
    expect(await evaluate<boolean>(`!document.querySelector('${waitingHint}')`)).toBe(true);
    expect(await evaluate<boolean>(releaseUploads)).toBe(true);
    await Bun.sleep(1_000);
    expect(await messagesIn(channelAId)).toHaveLength(1);
    expect(await messagesIn(channelBId)).toHaveLength(0);
    expect(await evaluate<string>(draft)).toBe("Saved draft in channel B.");
  } finally {
    if (channelAId) await deleteAttachmentRows(db, { conversationId: channelAId }).catch(() => {});
    if (channelBId) await deleteAttachmentRows(db, { conversationId: channelBId }).catch(() => {});
    await browser("close").catch(() => undefined);
    await db.workspace.delete({ where: { id: workspace.id } }).catch(() => {});
    await db.$disconnect();
    await Promise.all(
      files.map((filePath) =>
        Bun.file(filePath)
          .delete()
          .catch(() => {}),
      ),
    );
  }
}, 180_000);
