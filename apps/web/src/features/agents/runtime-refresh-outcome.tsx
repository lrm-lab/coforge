import type { RuntimeProvider } from "@lrm/coforge-sdk/internal";
import { m } from "#src/paraglide/messages";
import { runtimeUnavailableReason } from "#src/features/computers/runtime-unavailable-reason";
import { type RuntimeRefreshNote, refreshLatestNoteKey } from "./runtime-refresh-note";

/** The line under the model selector after a catalog refresh: how many models the provider offers
 * now, or the runtime's classified reason when the Computer could not refresh it. On Pi the count
 * comes with the reason it can be smaller than expected: only providers configured here count. */
export function RuntimeRefreshOutcome({
  note,
  runtime,
}: {
  note: RuntimeRefreshNote;
  runtime?: RuntimeProvider;
}) {
  if (note.kind === "latest")
    return (
      <p role="status" className="text-sm text-tertiary">
        {refreshLatestNoteKey(runtime) === "agent_form_model_refresh_latest_pi"
          ? m.agent_form_model_refresh_latest_pi({ count: note.modelCount })
          : m.agent_form_model_refresh_latest({ count: note.modelCount })}
      </p>
    );
  return (
    <p role="alert" className="text-sm text-error-primary">
      {note.code
        ? runtimeUnavailableReason(note.code, note.diagnostic)
        : m.agent_form_model_refresh_failed()}
    </p>
  );
}
