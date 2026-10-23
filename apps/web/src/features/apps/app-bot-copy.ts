import { isAppError } from "#src/lib/app-error";
import { m } from "#src/paraglide/messages";
import { APP_BOT_HANDLE_CONFLICT, APP_BOT_NOT_DECLARED } from "./app-bot";

/** A refused bot change as Settings shows it: what its `errorId` says, else `fallback`. */
export function botProblem(cause: unknown, fallback: () => string, handle?: string): string {
  const errorId = isAppError(cause) ? cause.errorId : undefined;
  if (errorId === APP_BOT_HANDLE_CONFLICT)
    return m.apps_bot_error_handle_conflict({ handle: handle ?? "" });
  if (errorId === APP_BOT_NOT_DECLARED) return m.apps_bot_error_not_declared();
  return fallback();
}
