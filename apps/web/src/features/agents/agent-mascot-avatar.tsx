import type { AvatarProps } from "#src/components/base/avatar/avatar";
import { StatusDot } from "#src/components/ui/status-dot";
import { m } from "#src/paraglide/messages";
import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";

import { agentDisplay } from "./agent-activity-presentation";
import type { AgentMascot } from "./agent-mascot";
import { AgentMascotView } from "./agent-mascot-view";
import { AvatarSticker } from "#src/features/avatars/avatar-sticker";
import { DELETED_PICTURE_CLASS } from "#src/features/avatars/deleted-avatar";
import { mascotActivity } from "./mascot-activity";

/**
 * An Agent's avatar where its mascot is the subject and may move: a Direct-message list row, the
 * Agent card, the Direct-message header and the profile panel header. The mascot is a bare
 * sticker, unclipped, and acts out the Agent's `display` (`mascotActivity`). A deleted Agent's is greyed, still and without a dot.
 */
export function AgentMascotAvatar({
  mascot,
  name,
  display,
  stopped,
  deleted = false,
  still = false,
  size = "sm",
  cornerDot = false,
  announced = false,
  hovered,
  className,
}: {
  mascot: AgentMascot;
  name: string;
  display?: AgentDisplaySnapshot;
  /** The user stopped this Agent; see `agentDisplay`. */
  stopped?: boolean;
  deleted?: boolean;
  /** The mascot stays a still picture (a second copy of an Agent already shown moving nearby). */
  still?: boolean;
  size?: NonNullable<AvatarProps["size"]>;
  /** Draw the status dot on the avatar's corner. */
  cornerDot?: boolean;
  /** Announce the avatar as an image named by the Agent and its status. Off where the name and
   * status already read beside it. */
  announced?: boolean;
  /** The pointer is over the row this avatar belongs to (`AgentMascotView`'s `hovered`). */
  hovered?: boolean;
  className?: string;
}) {
  const view = agentDisplay(display, { stopped });
  const avatar = (
    <AvatarSticker
      size={size}
      className={className}
      contentClassName={deleted ? DELETED_PICTURE_CLASS : undefined}
      badge={
        cornerDot && display && !deleted ? (
          <StatusDot tone={view.tone} pulse={view.pulse} className="avatar-status-dot absolute" />
        ) : undefined
      }
    >
      <AgentMascotView
        mascot={mascot}
        activity={mascotActivity(view.kind)}
        still={still || deleted}
        hovered={hovered}
      />
    </AvatarSticker>
  );
  return announced ? (
    <span
      role="img"
      aria-label={`${name}, ${deleted ? m.agent_deleted_badge() : view.label}`}
      className="relative flex shrink-0 rounded-[inherit]"
    >
      {avatar}
    </span>
  ) : (
    avatar
  );
}
