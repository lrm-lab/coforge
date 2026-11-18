import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { deleteAttachmentRows } from "#src/server/db/repositories/attachment-deletion.repositories.server";
import { PrismaWorkspaceCatalogStore } from "#src/server/workspaces/catalog.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";

const { origin, browserPath, databaseUrl } = localBrowserE2e();
const field = "textarea[placeholder]";
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
const failUploads = `window.__heldUploads.splice(0).forEach((upload) => upload.fail()) ?? true`;
const draft = `document.querySelector('${field}').value`;
const trayHas = (name: string) =>
  `document.querySelector('form:has(${field})').innerText.includes(${JSON.stringify(name)})`;

test("a send pressed while a file uploads goes out once, with the file, after the upload; a failed upload sends nothing", async () => {
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
  let conversationId = "";
  try {
    const channel = await db.conversation.create({
      data: {
        workspaceId: workspace.id,
        channelName: `upload-${suffix}`,
        members: { create: [{ userId: DEV_BROWSER_USER.id }] },
      },
    });
    conversationId = channel.id;
    const messages = () =>
      db.message.findMany({
        where: { conversationId },
        orderBy: { sequence: "asc" },
        include: { attachments: { orderBy: { createdAt: "asc" } } },
      });
    const waitForMessages = async (count: number) => {
      const deadline = Date.now() + 30_000;
      for (;;) {
        const found = await messages();
        if (found.length >= count) return found;
        if (Date.now() > deadline)
          throw new Error(`waited for ${count} messages, saw ${found.length}`);
        await Bun.sleep(200);
      }
    };
    const note = async (name: string) => {
      const path = `${Bun.env.TMPDIR ?? "/tmp"}/${name}`;
      await Bun.write(path, `${name}\n`);
      files.push(path);
      return path;
    };

    await browser("set", "viewport", "1440", "900");
    await browser("open", `${origin}/en/w/${slug}/channel/${conversationId}`);
    await browser("wait", "--fn", `${pageHydrated} && document.querySelector('${field}') !== null`);
    expect(await evaluate<boolean>(holdUploads)).toBe(true);

    const keptName = `kept-${suffix}.txt`;
    await browser("upload", 'input[type="file"]', await note(keptName));
    await browser("wait", "--fn", `${heldUploads} === 1 && ${trayHas(keptName)}`);
    await browser("fill", field, "Notes are attached.");
    await browser("press", "Enter");
    await Bun.sleep(1_000);
    expect(await messages()).toHaveLength(0);

    expect(await evaluate<boolean>(releaseUploads)).toBe(true);
    const [sent] = await waitForMessages(1);
    expect(sent!.body).toBe("Notes are attached.");
    expect(sent!.attachments.map((attachment) => attachment.fileName)).toEqual([keptName]);
    await browser("wait", "--fn", `${draft} === "" && !${trayHas(keptName)}`);
    await Bun.sleep(1_000);
    expect(await messages()).toHaveLength(1);

    const lostName = `lost-${suffix}.txt`;
    await browser("upload", 'input[type="file"]', await note(lostName));
    await browser("wait", "--fn", `${heldUploads} === 1 && ${trayHas(lostName)}`);
    await browser("fill", field, "This one fails.");
    await browser("press", "Enter");
    await Bun.sleep(1_000);
    expect(await evaluate<boolean>(failUploads)).toBe(true);
    await Bun.sleep(1_000);
    expect(await messages()).toHaveLength(1);
    expect(await evaluate<string>(draft)).toBe("This one fails.");
    expect(await evaluate<boolean>(trayHas(lostName))).toBe(true);
  } finally {
    if (conversationId) await deleteAttachmentRows(db, { conversationId }).catch(() => {});
    await browser("close").catch(() => undefined);
    await db.workspace.delete({ where: { id: workspace.id } }).catch(() => {});
    await db.$disconnect();
    await Promise.all(
      files.map((path) =>
        Bun.file(path)
          .delete()
          .catch(() => {}),
      ),
    );
  }
}, 120_000);
