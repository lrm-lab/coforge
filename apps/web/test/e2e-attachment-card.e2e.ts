import { expect, test } from "bun:test";
import { AttachmentComments } from "#src/server/attachments/attachment-comments.server";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { PrismaAttachmentCommentStore } from "#src/server/db/repositories/attachment-comments.repositories.server";
import { setupAgentReplying } from "./helpers/agent-replying-fixture";

/**
 * Browser E2E (task #238): a message's file cards, for the same files Raft's sample channel holds
 * (text, Markdown, CSV, JSON, PDF, HTML, code, a zip, a long name), in light and dark. The cards
 * render from the attachment rows alone, so no file is stored. Opt-in like the other browser
 * E2Es; see `helpers/agent-replying-fixture.ts`. Screenshots are written under
 * `.amp/e2e/attachment-card/`.
 */
const fx = setupAgentReplying({ artifactsName: "attachment-card" });
const { suffix, until } = fx;

const FILES: [name: string, contentType: string, sizeBytes: number][] = [
  ["t.txt", "text/plain", 11],
  ["t.md", "text/markdown", 18],
  ["t.csv", "text/csv", 8],
  ["t.json", "application/json", 8],
  ["t.pdf", "application/pdf", 543],
  ["t.html", "text/html", 38],
  ["t.py", "text/x-python", 12],
  ["t.ts", "video/mp2t", 21],
  ["t.zip", "application/zip", 109],
  ["lenovo-strategy-piresearch-20261027-092413.md", "text/markdown", 168_755],
];

test("file cards in light and dark", async () => {
  const channelId = await fx.createChannel(`e2e-cards-${suffix}`);
  const message = await fx.send(channelId, DEV_BROWSER_USER.id, `Cards ${suffix}`);
  const uploader = await fx.db.conversationMember.findFirstOrThrow({
    where: { conversationId: channelId, userId: DEV_BROWSER_USER.id },
    select: { userId: true },
  });
  const ids = new Map<string, string>();
  for (const [fileName, contentType, sizeBytes] of FILES) {
    const attachment = await fx.db.attachment.create({
      data: {
        workspaceId: fx.workspaceId,
        conversationId: channelId,
        messageId: message.id,
        uploaderId: uploader.userId!,
        objectKey: `e2e/cards/${suffix}/${fileName}`,
        fileName,
        contentType,
        sizeBytes,
      },
    });
    ids.set(fileName, attachment.id);
  }
  // Comments on two files: the card shows how many, a file without any shows nothing.
  const comments = new AttachmentComments(new PrismaAttachmentCommentStore(fx.db));
  const actor = { workspaceId: fx.workspaceId, userId: DEV_BROWSER_USER.id };
  const first = await comments.post(actor, { attachmentId: ids.get("t.md")!, body: "Looks good" });
  await comments.post(actor, { attachmentId: ids.get("t.md")!, body: "Agreed", rootId: first.id });
  await comments.post(actor, { attachmentId: ids.get("t.csv")!, body: "One more column?" });

  await fx.open(channelId);
  await until(`document.body.innerText.includes("t.zip")`, 60_000);
  await fx.screenshot("light.png");
  // Two cards to a row: the ten files take five rows.
  const rows = await fx.evaluate<number>(
    `new Set(${JSON.stringify(FILES.map(([name]) => name))}.map((name) => [...document.querySelectorAll("[aria-label]")].find((el) => el.getAttribute("aria-label").includes(name))?.getBoundingClientRect().top)).size`,
  );
  expect(rows).toBe(5);
  const labels = await fx.evaluate<string[]>(
    `[...document.querySelectorAll("[aria-label]")].map((el) => el.getAttribute("aria-label")).filter((label) => /t\\.(md|csv|txt)$|comment/.test(label))`,
  );
  expect(labels).toContain("Preview t.md, 2 comments");
  expect(labels).toContain("Preview t.csv, 1 comment");
  // The app's own theme setting, as Settings stores it.
  await fx.evaluate(`localStorage.setItem("coforge-theme", "dark")`);
  try {
    await fx.open(channelId);
    await until(`document.body.innerText.includes("t.zip")`, 60_000);
    await fx.screenshot("dark.png");
  } finally {
    await fx.evaluate(`localStorage.removeItem("coforge-theme")`);
  }
}, 240_000);
