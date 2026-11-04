import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { MARKDOWN_CHUNK_THRESHOLD } from "#src/features/records/report-editor/utils/parse-markdown-chunked";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { recordAssistantCatalog } from "#src/server/records/record-assistant-catalog.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";

/**
 * A note past `MARKDOWN_CHUNK_THRESHOLD` opens (found in task #385's check of the shared editor):
 * the editor parses it in chunks, and that path read the parser from `editor.storage.markdown`,
 * which only holds it, and waited on a result that is not a promise, so such a note failed to load
 * at all. Opening is no edit either: nothing is saved by it.
 *
 * Opt-in like the other browser E2Es: a real local Web, the dev user, `agent-browser`. The note is
 * seeded per run and removed after it.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();

test("a note past the chunk threshold opens with its text and saves nothing", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `note-large-${process.pid}`);
  const { workspaceId, workspace } = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id },
    include: { workspace: { select: { slug: true } } },
  });
  const notes = recordAssistantCatalog(db);
  const sections = Array.from(
    { length: 600 },
    (_, index) =>
      `## Section ${index + 1}\n\nThe plan for part ${index + 1}: what ships, who owns it, how it is reviewed, and when it is checked again.`,
  );
  const body = `${sections.join("\n\n")}\n\nThe last line of the note.`;
  expect(body.length).toBeGreaterThan(MARKDOWN_CHUNK_THRESHOLD);
  const { id } = await notes.createNote({
    workspaceId,
    userId: DEV_BROWSER_USER.id,
    title: "Large note",
  });
  try {
    await notes.saveNote({ workspaceId, userId: DEV_BROWSER_USER.id, noteId: id, body });
    const saved = await db.recordNote.findUniqueOrThrow({ where: { id } });
    await browser("set", "viewport", "1440", "900");
    await browser("open", `${origin}/en/w/${workspace.slug}/records/${id}`);
    await browser(
      "wait",
      "--fn",
      `${pageHydrated} && document.querySelector(".ProseMirror")?.textContent.includes("The last line of the note.")`,
    );
    expect(await evaluate<number>(`document.querySelectorAll(".ProseMirror h2").length`)).toBe(600);
    // Longer than the editor's autosave debounce: opening must not have written the note.
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const after = await db.recordNote.findUniqueOrThrow({ where: { id } });
    expect(after.updatedAt.toISOString()).toBe(saved.updatedAt.toISOString());
    expect(after.body).toBe(body);
  } finally {
    await browser("close").catch(() => undefined);
    await db.recordNote.deleteMany({ where: { id } }).catch(() => undefined);
    await db.$disconnect();
  }
}, 120_000);
