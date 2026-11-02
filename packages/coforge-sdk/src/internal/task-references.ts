/**
 * Structured task references — the stored-body form of a task reference, in the same spirit as the
 * embedded mention token (`<@human:uuid>` / `<@agent:uuid>`, see `mentions.ts`).
 *
 * A writer types `task #68`; the server resolves it at send time (the Web message-reference
 * recognizer) against the conversation's own tasks and stores a token (`<@task:68>`), so a number
 * that names no task stays ordinary text. A bare `#68` is never a task: it reads as a channel, as
 * Raft does. Only a token is ever a
 * reference: a body is never re-read for bare numbers when it is shown. Translation back happens at
 * the edges: the browser draws a chip, and every plain-text reader (an Agent-facing body, a copy, a
 * list preview) reads `task #N` — never the raw token.
 */

/**
 * The prose form `task #68`: case-insensitive, whole-word `task` (so `mytask #5` is not this form)
 * and the number not a prefix of a longer one (so `#680` is left alone).
 */
export const TASK_REFERENCE_PATTERN = /(?<![A-Za-z0-9_])task #(\d+)(?![0-9])/gi;

/** The stored-body token for one resolved task reference: `<@task:68>`. */
export const TASK_REFERENCE_TOKEN_PATTERN = /<@task:(\d+)>/gi;

/** The stored-body token for one task number. */
export function taskReferenceToken(number: number): string {
  return `<@task:${number}>`;
}

/**
 * Rewrites every task-reference token through `resolve`, leaving a token `resolve` does not know
 * byte-for-byte intact — the same contract as `replaceMentionTokens`, so a caller that lacks the
 * task rows degrades to the raw token rather than dropping the reference.
 */
export function replaceTaskReferenceTokens(
  body: string,
  resolve: (number: number) => string | undefined,
): string {
  return body.replace(
    TASK_REFERENCE_TOKEN_PATTERN,
    (token, digits: string) => resolve(Number(digits)) ?? token,
  );
}
