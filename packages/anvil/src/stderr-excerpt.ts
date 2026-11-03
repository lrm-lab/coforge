type StderrSource = {
  stderrExcerpt(): string;
};

/**
 * Puts the process's scrubbed stderr head on a failed session call, and keeps the same error so
 * its code stays. An empty head leaves the error as it was. A frozen message stays unchanged: the
 * process log still has the head.
 */
export function attachStderrExcerpt(source: StderrSource, error: unknown): void {
  if (!(error instanceof Error)) return;
  const excerpt = source.stderrExcerpt();
  if (!excerpt || error.message.includes(excerpt)) return;
  const message = `${error.message}\n${excerpt}`;
  try {
    error.message = message;
  } catch {
    // The message property is not writable. The failure log still carries the head.
  }
}
