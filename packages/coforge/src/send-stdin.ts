import { fstatSync } from "node:fs";
import { CliError, type CliErrorInit } from "#src/cli-error";

/** Reads the bytes a caller piped in. The stream is single-use, so an invocation that already
 * observed it (only possible when one process runs several sends, as the test harness does) has
 * nothing left to read rather than an error to report. */
export async function readPipedSendContent(): Promise<string> {
  try {
    return await new Response(Bun.stdin.stream()).text();
  } catch {
    return "";
  }
}

/** Refuses stdin the shell redirected from a regular file another user owns. Such a file is not
 * this Agent's content: when writing it to a shared path fails, the file still holds its owner's
 * earlier content, and posting it would put that under this Agent's name. Pipes, here-documents
 * (which the shell creates as the caller) and platforms without uids pass. `heredoc` is the
 * command, as a quoted here-document, the Agent should run instead. */
export function refuseForeignStdinFile(
  heredoc: readonly string[],
  init: Pick<CliErrorInit, "draftSaved" | "suggestedNextAction" | "outputMode"> = {},
): void {
  const callerUid = process.getuid?.();
  if (callerUid === undefined) return;
  let stdin;
  try {
    stdin = fstatSync(0);
  } catch {
    return;
  }
  if (!stdin.isFile() || stdin.uid === callerUid) return;
  throw new CliError({
    code: "STDIN_FILE_NOT_OWNED",
    message: [
      `stdin is redirected from a file owned by uid ${stdin.uid}, not by you (uid ${callerUid}). Nothing was sent.`,
      "That file is not your content: if writing your content to it failed, it still holds its owner's earlier content.",
      "Pass the content as a quoted heredoc instead of through a file:",
      ...heredoc.map((line) => `  ${line}`),
    ].join("\n"),
    retryable: false,
    ...init,
  });
}

/** How long `--send-draft` watches stdin before deciding nothing was piped in (a bounded
 * observation window: the flag replays the daemon-held copy, so piped content is a mistake to
 * report, not a body to silently discard). */
export const SEND_DRAFT_STDIN_OBSERVATION_MS = 150;

export async function sendDraftStdinHasContent(): Promise<boolean> {
  const reader = Bun.stdin.stream().getReader();
  const deadline = new Promise<{ done: true; value: undefined }>((resolve) =>
    setTimeout(
      () => resolve({ done: true as const, value: undefined }),
      SEND_DRAFT_STDIN_OBSERVATION_MS,
    ),
  );
  try {
    const first = await Promise.race([reader.read(), deadline]);
    return !first.done && (first.value?.length ?? 0) > 0;
  } finally {
    reader.releaseLock();
  }
}
