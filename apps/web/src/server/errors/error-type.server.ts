/**
 * What a log line names a caught error by: its class name (`TypeError`, a Prisma error class), or
 * the `typeof` of something thrown that is not an `Error`. Never its message, which can carry a
 * path, a payload or user text.
 */
export function errorType(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
