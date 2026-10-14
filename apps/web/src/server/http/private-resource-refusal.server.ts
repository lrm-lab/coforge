import { isAppError } from "#src/lib/app-error";

/**
 * How a private image or file route refuses: the `AppError`'s code as `{ code }`, never cached,
 * with 401 for `ACCESS_DENIED` (no session), 404 for `NOT_FOUND` (absent, or not visible to this
 * viewer) and 503 for anything else. A thrown value that is not an `AppError` is rethrown.
 *
 * The Workspace icon, Agent avatar, Workspace member avatar, project icon and project raw-file
 * routes each wrote this out by hand. `/api/me/avatar` (which also answers 400 for an upload) and
 * the Computer creator avatar (403 rather than 401) refuse differently and keep their own.
 */
export function privateResourceRefusal(error: unknown): Response {
  if (!isAppError(error)) throw error;
  const status = error.code === "ACCESS_DENIED" ? 401 : error.code === "NOT_FOUND" ? 404 : 503;
  return Response.json({ code: error.code }, { status, headers: { "cache-control": "no-store" } });
}
