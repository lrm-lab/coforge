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
