/** A row that names a task conversation: `#channel:#7 …` or `dm:@name:#7 …`. */
const TASK_ROW = /^(#[^\s:]+|dm:@[^\s:]+):#[1-9]\d*(\s|$)/;

const TASK_HINT =
  "A task conversation (a '#channel:#7' target) is read with 'coforge task read <ref> --unread' and replied to with 'coforge task reply <ref>'.";

/**
 * The text of one inbox notice: one line per target, each naming what waits there. Never a message
 * body and never how to read an ordinary target — the standing instructions carry that, once. A
 * task conversation is read with a different command, so a notice that lists one says so.
 */
export function inboxNoticeText(rows: readonly string[]): string {
  return `[CoForge inbox notice:
${rows.join("\n")}${taskHint(rows)}]`;
}

/** The sentence a notice appends when any row is a task conversation, led by a newline. */
export function taskHint(rows: readonly string[]): string {
  return rows.some((row) => TASK_ROW.test(row)) ? `\n${TASK_HINT}` : "";
}
