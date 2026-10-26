import { open } from "node:fs/promises";
import { dirname } from "node:path";
import {
  parseAttachmentCommentMigrationJournal,
  type AttachmentCommentMigrationJournal,
} from "#src/server/attachments/attachment-comment-migration-journal.server";

/** Owner-only, exclusive creation and fsync are why this uses the filesystem compatibility API. */
export async function writeAttachmentCommentJournal(
  path: string,
  journal: AttachmentCommentMigrationJournal,
) {
  parseAttachmentCommentMigrationJournal(journal);
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(journal));
    await file.sync();
  } finally {
    await file.close();
  }
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
export async function readAttachmentCommentJournal(path: string) {
  const file = await open(path, "r");
  try {
    const info = await file.stat();
    if (!info.isFile() || (info.mode & 0o077) !== 0)
      throw new Error("Journal must be an owner-only regular file");
    let value: unknown;
    try {
      value = JSON.parse(await file.readFile("utf8"));
    } catch {
      throw new Error("Invalid local copy migration journal");
    }
    return parseAttachmentCommentMigrationJournal(value);
  } finally {
    await file.close();
  }
}
