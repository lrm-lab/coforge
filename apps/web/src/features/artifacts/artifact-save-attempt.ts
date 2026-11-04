/** What a document save sends that decides what it creates. */
export type SavePayload = {
  baseVersion: number;
  text: string;
  title?: string;
  description?: string;
};

/** A save attempt: its idempotency key, and what it sent under that key. */
export type SaveAttempt = { key: string; sent: string };

/**
 * The idempotency key for a save (task #385). A save that failed may have landed with only its
 * answer lost, so the retry of exactly the same save reuses its key and the server answers the
 * first one. Anything else - an edit since, a resolved conflict, a new base - is a new save with a
 * new key: under the old key the server would answer the first save, and the page would take that
 * version for this one.
 */
export function nextSaveAttempt(
  last: SaveAttempt | null,
  payload: SavePayload,
  newKey: () => string = () => crypto.randomUUID(),
): SaveAttempt {
  const sent = JSON.stringify([
    payload.baseVersion,
    payload.title ?? null,
    payload.description ?? null,
    payload.text,
  ]);
  return last?.sent === sent ? last : { key: newKey(), sent };
}
