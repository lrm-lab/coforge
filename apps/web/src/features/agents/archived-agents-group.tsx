import { Link, useHydrated } from "@tanstack/react-router";
import { Archive } from "@untitledui/icons";

import { Badge } from "#src/components/base/badges/badges";
import { SettingsGroup } from "#src/components/settings-content";
import { formatDateForDisplay } from "#src/lib/dates";
import { useTimeFormat } from "#src/lib/time-format-context";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { AgentDisplayAvatar } from "./agent-display-avatar";
import type { loadArchivedAgents } from "./agents.functions";

type ArchivedAgents = Awaited<ReturnType<typeof loadArchivedAgents>>;
type ArchivedAgent = NonNullable<ArchivedAgents>[number];

/**
 * Settings → Workspace profile → Archived agents: every archived Agent, for a Workspace owner or
 * admin to open its read-only profile. Absent (no empty state) when there is none or the viewer is
 * not an owner or admin. An archived Agent cannot be brought back, so the list offers no action.
 */
export function ArchivedAgentsGroup({
  agents,
  timeZone,
}: {
  agents: ArchivedAgents;
  timeZone: string | null;
}) {
  const workspaceSlug = useWorkspaceSlug();
  if (!agents?.length) return null;

  return (
    <SettingsGroup
      icon={Archive}
      label={m.settings_archived_agents()}
      badge={
        <Badge type="pill-color" color="gray" size="sm">
          {agents.length}
        </Badge>
      }
    >
      <ul className="divide-y divide-secondary rounded-xl border border-secondary bg-primary shadow-xs">
        {agents.map((agent) => (
          <ArchivedAgentRow
            key={agent.id}
            agent={agent}
            workspaceSlug={workspaceSlug}
            timeZone={timeZone}
          />
        ))}
      </ul>
    </SettingsGroup>
  );
}

function ArchivedAgentRow({
  agent,
  workspaceSlug,
  timeZone,
}: {
  agent: ArchivedAgent;
  workspaceSlug: string;
  timeZone: string | null;
}) {
  // Locale, zone and hour cycle are only known in the browser, so the date waits for hydration.
  const hydrated = useHydrated();
  const timeFormat = useTimeFormat();

  return (
    <li className="flex min-w-0 items-center gap-3 p-4 sm:px-5">
      <AgentDisplayAvatar name={agent.displayName} src={agent.avatarUrl} deleted size="md" />
      <div className="min-w-0">
        <Link
          to="/w/$workspaceSlug/agent/$agentId"
          params={{ workspaceSlug, agentId: agent.id }}
          aria-label={m.settings_archived_agents_open({ name: agent.displayName })}
          className="block truncate rounded-xs text-sm font-semibold text-primary underline underline-offset-2 outline-focus-ring hover:text-secondary focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          {agent.displayName}
        </Link>
        <p className="text-sm text-tertiary">
          {hydrated && (
            <time dateTime={agent.archivedAt.toISOString()}>
              {m.settings_archived_channels_archived_at({
                time: formatDateForDisplay(agent.archivedAt, timeZone, getLocale(), timeFormat),
              })}
            </time>
          )}
          {hydrated && agent.computerName && " · "}
          {agent.computerName &&
            m.settings_archived_agents_ran_on({ computer: agent.computerName })}
        </p>
      </div>
    </li>
  );
}
