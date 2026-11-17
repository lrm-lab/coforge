import { Link } from "@tanstack/react-router";
import { Button } from "#src/components/base/buttons/button";
import { formatAgentProfileParam } from "#src/features/agents/profile-panel/profile-panel-search";
import { m } from "#src/paraglide/messages";

export function RecordAssistantSetupCard({
  workspaceSlug,
  agentId,
  onDismiss,
}: {
  workspaceSlug: string;
  agentId: string;
  onDismiss: () => void;
}) {
  return (
    <div className="space-y-3 rounded-xl border border-secondary bg-warning-primary p-3">
      <div>
        <p className="text-sm font-semibold text-primary">{m.records_weekly_ai_setup_title()}</p>
        <p className="mt-1 text-sm text-secondary">{m.records_weekly_ai_setup_description()}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Link
          to="/w/$workspaceSlug/members"
          params={{ workspaceSlug }}
          search={{ profile: formatAgentProfileParam(agentId), agentTab: "profile" }}
          className="text-sm font-semibold text-brand-secondary"
        >
          {m.records_weekly_ai_setup_action()}
        </Link>
        <Button size="sm" color="tertiary" onPress={onDismiss}>
          {m.records_weekly_ai_setup_dismiss()}
        </Button>
      </div>
    </div>
  );
}
