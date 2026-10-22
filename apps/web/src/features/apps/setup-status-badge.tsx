import { Badge } from "#src/components/base/badges/badges";
import { m } from "#src/paraglide/messages";
import type { SetupStatus } from "./app-installation-setup";

const SETUP_STATUS_BADGES = {
  complete: { color: "success", label: m.apps_setup_complete },
  pending: { color: "warning", label: m.apps_setup_pending },
  not_required: { color: "gray", label: m.apps_setup_not_required },
} as const;

/** An installation's setup status as a badge: the one colour and wording every surface uses. */
export function SetupStatusBadge({ status }: { status: SetupStatus }) {
  const { color, label } = SETUP_STATUS_BADGES[status];
  return (
    <Badge size="sm" color={color}>
      {label()}
    </Badge>
  );
}

/** What an installer is told while setup is unfinished: the app's instructions, when it gave any,
 * and the host of the page they continue on. */
export function SetupDirections({ url, description }: { url: string; description: string }) {
  return (
    <div className="grid gap-1">
      {description && (
        <p className="text-sm break-words whitespace-pre-line text-secondary">{description}</p>
      )}
      <p className="text-sm text-tertiary">
        {m.apps_setup_continue_at({ host: new URL(url).host })}
      </p>
    </div>
  );
}
