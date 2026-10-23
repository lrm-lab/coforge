import { Badge } from "#src/components/base/badges/badges";
import { RelativeTime } from "#src/components/ui/relative-time";
import { IdentityAvatar } from "#src/features/avatars/identity-avatar";
import { humanLabel } from "#src/lib/human-label";
import { m } from "#src/paraglide/messages";
import type { getAgentProfile } from "#src/features/agents/agents.functions";
import { FactRow } from "./agent-fact-row";
import { SECTION_CAPTION_CLASS } from "./inline-edit-field";

type AgentProfile = NonNullable<Awaited<ReturnType<typeof getAgentProfile>>>;

/**
 * An app's bot as its Profile tab shows it: the app's name and logo as they are now, the "Bot"
 * badge, who manages it (the app) and the line the app published. It has no Computer, runtime,
 * model or session, so none of the runtime sections, actions or controls exist here; the grant is
 * changed in Settings → Applications.
 */
export function AppBotProfile({
  profile,
  timeZone,
}: {
  profile: AgentProfile & { appBot: NonNullable<AgentProfile["appBot"]> };
  timeZone: string | null;
}) {
  const { appBot } = profile;
  const creator = humanLabel(profile.owner);
  return (
    <div className="relative min-h-0 flex-1 overflow-y-auto">
      <section className="border-b border-secondary px-6 py-5">
        <div className="mb-4 flex items-center gap-4">
          <IdentityAvatar size="xl" name={appBot.appName} src={appBot.logoUrl} />
          <Badge size="sm" color="brand">
            {m.agent_bot_badge()}
          </Badge>
        </div>
        <p className="text-lg font-semibold text-primary">{appBot.appName}</p>
        <p className="text-sm text-tertiary">@{profile.name}</p>
        {appBot.statusText && (
          <p className="mt-3 text-sm wrap-anywhere text-secondary">{appBot.statusText}</p>
        )}
        {profile.description && (
          <p className="mt-3 text-sm wrap-anywhere whitespace-pre-line text-secondary">
            {profile.description}
          </p>
        )}
      </section>
      <section className="px-6 py-5">
        <p className={SECTION_CAPTION_CLASS}>{m.agent_profile_section_info()}</p>
        <div className="mt-3 flex flex-col gap-3">
          <FactRow label={m.agent_bot_managed_label()}>
            {m.agent_bot_managed_by_app({ app: appBot.appName })}
          </FactRow>
          <FactRow label={m.agent_profile_created()}>
            <RelativeTime value={profile.createdAt} timeZone={timeZone} />
          </FactRow>
          <FactRow label={m.agent_bot_granted_by()}>
            <span className="truncate">{creator}</span>
          </FactRow>
        </div>
      </section>
    </div>
  );
}
