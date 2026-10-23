import { Badge } from "#src/components/base/badges/badges";
import { m } from "#src/paraglide/messages";

/**
 * The single place that renders a deleted Agent's identity treatment. A deleted Agent
 * keeps its history, so it can still appear in message rows, the thread root, the thread reply
 * preview and the DM header; all of those share this module so the grey avatar and the `ARCHIVED`
 * badge cannot drift apart between surfaces. The grey avatar itself is `features/avatars/deleted-avatar.ts`.
 */

/** The `ARCHIVED` (已归档) marker shown beside a deleted Agent's name. */
export function DeletedAgentBadge() {
  return (
    <Badge size="sm" color="gray" className="shrink-0 font-semibold tracking-wide">
      {m.agent_deleted_badge()}
    </Badge>
  );
}
