import { isAppError } from "#src/lib/app-error";
import { m } from "#src/paraglide/messages";

/** A failed save as a form shows it: the sentence, and the error reference when there is one. */
export type SaveError = { message: string; errorId?: string };

export function saveErrorFrom(message: string, cause: unknown): SaveError {
  return { message, errorId: isAppError(cause) ? cause.errorId : undefined };
}

// The failure sentence stays red; its error reference sits on its own grey line below it.
export function SaveErrorMessage({ error }: { error: SaveError }) {
  return (
    <div className="flex flex-col gap-1">
      <p role="alert" className="text-sm text-error-primary">
        {error.message}
      </p>
      {error.errorId && (
        <p className="text-xs text-tertiary">{m.error_reference({ errorId: error.errorId })}</p>
      )}
    </div>
  );
}
