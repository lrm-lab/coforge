import type { AvatarProps } from "#src/components/base/avatar/avatar";
import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";
import { StatusDot } from "#src/components/ui/status-dot";
import { IdentityAvatar } from "#src/features/avatars/identity-avatar";
import { m } from "#src/paraglide/messages";
import { agentDisplay } from "./agent-activity-presentation";
import { agentAvatarUrl } from "./agent-mascot";

export type AvatarSize = NonNullable<AvatarProps["size"]>;

export function AgentDisplayAvatar({
  agentId,
  name,
  src,
  display,
  stopped,
  deleted,
  size = "sm",
  cornerDot = true,
  className,
}: {
  /** The Agent's id, which picks its default picture. */
  agentId: string;
  name: string;
  /** The Agent's avatar URL. Its default picture stands in until it is known, so an
   * Agent never flashes initials while its data loads. */
  src?: string | null;
  display?: AgentDisplaySnapshot;
  /** The user stopped this Agent; see `agentDisplay`. */
  stopped?: boolean;
  /** The Agent was deleted. Its avatar renders greyed wherever it appears, so a deleted
   * identity is recognisable outside message rows too (DM header, mention chips, member cards). */
  deleted?: boolean;
  size?: AvatarSize;
  /** Draw the status dot on the avatar's corner. Off where the status already reads inline
   * beside the name (the DM header), so it is not shown twice. */
  cornerDot?: boolean;
  className?: string;
}) {
  const view = agentDisplay(display, { stopped });
  const picture = src ?? agentAvatarUrl(agentId);
  const badge =
    cornerDot && display && !deleted ? (
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

/** One face in an overlapping stack of Agents: its sticker with no status dot, which the overlap
 * would half cover, and the same page-coloured separator ring as the stack's "+N" chip, so the
 * overlapping stickers read as separate faces. */
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
      className="ring-2 ring-bg-primary"
    />
  );
}
