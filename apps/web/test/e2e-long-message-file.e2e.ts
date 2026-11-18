import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { MESSAGE_BODY_MAX_LENGTH } from "@lrm/coforge-sdk/internal";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { deleteAttachmentRows } from "#src/server/db/repositories/attachment-deletion.repositories.server";
import { PrismaWorkspaceCatalogStore } from "#src/server/workspaces/catalog.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";

const { origin, browserPath, databaseUrl } = localBrowserE2e();
const field = "textarea[placeholder]";
const paste = (text: string) => `(() => {
  const data = new DataTransfer();
  data.setData("text/plain", ${JSON.stringify(text)});
  const event = new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true });
  const target = document.querySelector('${field}');
  target.focus();
  target.dispatchEvent(event);
  return event.defaultPrevented;
})()`;
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
    window.__heldUploads.push(() => send.call(this, body));
  };
  return true;
})()`;
const heldUploads = `window.__heldUploads.length`;
const releaseUploads = `window.__heldUploads.splice(0).forEach((release) => release()) ?? true`;
const composerReady = `${pageHydrated} && document.querySelector('${field}') !== null`;
const draft = `document.querySelector('${field}').value`;
const trayHas = (name: string) =>
  `(document.querySelector('form:has(${field})')?.innerText ?? "").includes(${JSON.stringify(name)})`;
const sendReady = `document.querySelector('form:has(${field}) button[aria-label="Send"]')?.disabled === false`;
const trayLabels = `[...document.querySelectorAll("form:has(${field}) [aria-label]")].map((tile) => tile.getAttribute("aria-label")).join(" | ")`;
const onChannel = (id: string) =>
  `${composerReady} && location.pathname.endsWith(${JSON.stringify(id)})`;
const trayFiles = `[...document.querySelectorAll("form *")].filter((el) => el.children.length === 0 && /^message-\\d{8}-\\d{6}\\.md$/.test(el.textContent.trim())).length`;

test("a message past the limit goes out as a Markdown file with a preview; the limit itself does not", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `long-message-${process.pid}`);
  const suffix = String(process.pid);
  const slug = `e2e-long-message-${suffix}`;
  const workspace = await new PrismaWorkspaceCatalogStore(db).createForUser({
    slug,
    name: "E2E long message",
    userId: DEV_BROWSER_USER.id,
  });
  let conversationId = "";
  try {
    const channel = await db.conversation.create({
      data: {
        workspaceId: workspace.id,
        channelName: `long-${suffix}`,
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

    await browser("set", "viewport", "1440", "900");
    await browser("open", `${origin}/en/w/${slug}/channel/${conversationId}`);
    await browser("wait", "--fn", `${pageHydrated} && document.querySelector('${field}') !== null`);

    const atLimit = "a".repeat(MESSAGE_BODY_MAX_LENGTH);
    expect(await evaluate<boolean>(paste(atLimit))).toBe(false);
    expect(await evaluate<number>(trayFiles)).toBe(0);
    await browser("fill", field, atLimit);
    await browser("press", "Enter");
    const [first] = await waitForMessages(1);
    expect(first!.body).toBe(atLimit);
    expect(first!.attachments).toEqual([]);

    const lines = ["Release notes", "", "- one", "- two", "- three", "- four"];
    const long = `${lines.join("\n")}\n${"b".repeat(MESSAGE_BODY_MAX_LENGTH)}`;
    expect(await evaluate<boolean>(paste(long))).toBe(true);
    await browser("wait", "--fn", `${trayFiles} === 1`);
    expect(await evaluate<string>(`document.querySelector('${field}').value`)).toBe("");
    expect(await evaluate<boolean>(`/too long|超长/i.test(document.body.innerText)`)).toBe(false);
    for (const deadline = Date.now() + 30_000; ; await Bun.sleep(200)) {
      const uploaded = await db.attachment.count({
        where: { conversationId, messageId: null, fileName: { endsWith: ".md" } },
      });
      if (uploaded === 1) break;
      if (Date.now() > deadline) throw new Error("the pasted file never finished uploading");
    }
    await browser("press", "Enter");
    const second = (await waitForMessages(2))[1]!;
    expect(second.body).toBe(
      "Release notes\n\n- one\n- two\n- three…\n\nFull text in the attached file.",
    );
    expect(second.attachments).toHaveLength(1);
    expect(second.attachments[0]!.fileName).toMatch(/^message-\d{8}-\d{6}\.md$/);
    expect(second.attachments[0]!.contentType).toStartWith("text/markdown");
    expect(second.attachments[0]!.sizeBytes).toBe(new TextEncoder().encode(`${long}\n`).byteLength);

    const note = `${Bun.env.TMPDIR ?? "/tmp"}/long-message-note-${suffix}.txt`;
    await Bun.write(note, "kept alongside\n");
    await browser("upload", 'input[type="file"]', note);
    await browser("fill", field, "c".repeat(MESSAGE_BODY_MAX_LENGTH + 1));
    await browser("press", "Enter");
    const third = (await waitForMessages(3))[2]!;
    expect(third.attachments.map((attachment) => attachment.fileName)).toEqual([
      `long-message-note-${suffix}.txt`,
      expect.stringMatching(/\.md$/),
    ]);
  } finally {
    if (conversationId) await deleteAttachmentRows(db, { conversationId }).catch(() => {});
    await browser("close").catch(() => undefined);
    await db.workspace.delete({ where: { id: workspace.id } }).catch(() => {});
    await db.$disconnect();
  }
}, 120_000);

test("a file still uploading stays in the draft across a channel switch, then goes out once", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `draft-files-${process.pid}`);
  const suffix = String(process.pid);
  const slug = `e2e-draft-files-${suffix}`;
  const workspace = await new PrismaWorkspaceCatalogStore(db).createForUser({
    slug,
    name: "E2E draft files",
    userId: DEV_BROWSER_USER.id,
  });
  const path = `${Bun.env.TMPDIR ?? "/tmp"}/draft-file-${suffix}.txt`;
  const name = `draft-file-${suffix}.txt`;
  let conversationId = "";
  try {
    const [channel, other] = await Promise.all(
      ["kept", "other"].map((label) =>
        db.conversation.create({
          data: {
            workspaceId: workspace.id,
            channelName: `${label}-${suffix}`,
            members: { create: [{ userId: DEV_BROWSER_USER.id }] },
          },
        }),
      ),
    );
    conversationId = channel!.id;
    const otherId = other!.id;
    const messages = () =>
      db.message.findMany({ where: { conversationId }, include: { attachments: true } });
    await Bun.write(path, "kept\n");

    await browser("set", "viewport", "1440", "900");
    await browser("open", `${origin}/en/w/${slug}/channel/${conversationId}`);
    await browser("wait", "--fn", composerReady);
    expect(await evaluate<boolean>(holdUploads)).toBe(true);
    await browser("upload", 'input[type="file"]', path);
    await browser("wait", "--fn", `${heldUploads} === 1 && ${trayHas(name)}`);
    await browser("fill", field, "With the notes.");

    await browser("click", `a[href$="/channel/${otherId}"]`);
    await browser("wait", "--fn", `${onChannel(otherId)} && !${trayHas(name)}`);
    await browser("click", `a[href$="/channel/${conversationId}"]`);
    await browser("wait", "--fn", onChannel(conversationId));
    await Bun.sleep(500);
    expect(await evaluate<boolean>(trayHas(name))).toBe(true);
    expect(await evaluate<string>(draft)).toBe("With the notes.");

    expect(await evaluate<boolean>(releaseUploads)).toBe(true);
    await browser("wait", "--fn", `${sendReady} === true`).catch(async (error) => {
      throw new Error(`Send never opened; tray: ${await evaluate<string>(trayLabels)}`, {
        cause: error,
      });
    });
    expect(await evaluate<boolean>(`document.querySelector('${field}').focus() ?? true`)).toBe(
      true,
    );
    await browser("press", "Enter");
    await browser("wait", "--fn", `${draft} === "" && !${trayHas(name)}`);
    for (
      const deadline = Date.now() + 30_000;
      (await messages()).length === 0;
      await Bun.sleep(200)
    )
      if (Date.now() > deadline) throw new Error("the message never arrived");
    await Bun.sleep(1_500);
    const sent = await messages();
    expect(
      sent.map((message) => [message.body, message.attachments.map((file) => file.fileName)]),
    ).toEqual([["With the notes.", [name]]]);
    expect(await db.attachment.count({ where: { conversationId } })).toBe(1);
  } finally {
    if (conversationId) await deleteAttachmentRows(db, { conversationId }).catch(() => {});
    await browser("close").catch(() => undefined);
    await db.workspace.delete({ where: { id: workspace.id } }).catch(() => {});
    await db.$disconnect();
    await Bun.file(path)
      .delete()
      .catch(() => {});
  }
}, 120_000);
