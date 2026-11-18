import type { AvatarProps } from "#src/components/base/avatar/avatar";
import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";
import { StatusDot } from "#src/components/ui/status-dot";
import { IdentityAvatar } from "#src/features/avatars/identity-avatar";
import { m } from "#src/paraglide/messages";
import { agentDisplay } from "./agent-status-display";
import { agentAvatarUrl } from "./agent-mascot";
import { AVATAR_STACK_RING } from "#src/features/avatars/avatar-stack-ring";

export type AvatarSize = NonNullable<AvatarProps["size"]>;

export function AgentDisplayAvatar({
  agentId,
  name,
  src,
  noIdDefault,
  display,
  stopped,
  deleted,
  size = "sm",
  cornerDot = true,
  className,
}: {
  agentId: string;
  name: string;
  src?: string | null;
  noIdDefault?: boolean;
  display?: AgentDisplaySnapshot;
  stopped?: boolean;
  deleted?: boolean;
  size?: AvatarSize;
  cornerDot?: boolean;
  className?: string;
}) {
  const view = agentDisplay(display, { stopped });
  const picture = src ?? (noIdDefault ? null : agentAvatarUrl(agentId));
  const badge =
    cornerDot && !deleted ? (
      <StatusDot tone={view.tone} pulse={view.pulse} className="avatar-status-dot absolute" />
    ) : undefined;
  return (
    <span
      role="img"
      aria-label={`${name}, ${deleted ? m.agent_deleted_badge() : view.label}`}
      className="relative flex shrink-0 rounded-[inherit]"
    >
      <IdentityAvatar
        size={size}
        className={className}
        alt=""
        src={picture}
        name={name}
        deleted={deleted}
        badge={badge}
      />
    </span>
  );
}

export function AgentStackFace({
  agent,
}: {
  agent: { id: string; displayName: string; avatarUrl?: string | null };
}) {
  return (
    <IdentityAvatar
      size="xs"
      alt=""
      src={agent.avatarUrl ?? agentAvatarUrl(agent.id)}
      name={agent.displayName}
      className={AVATAR_STACK_RING.regular}
    />
  );
}
