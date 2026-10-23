import type { ReactNode } from "react";

import { AgentHoverCard } from "#src/features/agents/agent-hover-card";
import type {
  OpenAgentProfile,
  OpenPersonProfile,
} from "#src/features/agents/profile-panel/open-agent-profile";
import { cn } from "#src/lib/utils";
import { MENTION_CHIP_OPENABLE_CLASS } from "./message-markdown";
import { PersonHoverCard } from "./person-hover-card";

/** The chip's own classes plus the pointer and hover affordance of a control. The trigger is an
 * inline `<span>`, so the chip wraps across lines and selects like the text around it. */
function openableChipClassName(className: string | undefined) {
  return cn(className, MENTION_CHIP_OPENABLE_CLASS);
}

/** The accessible name of a chip: the `@name` it shows, so a screen reader reads the sentence
 * whole; the popup it announces (`aria-haspopup`) carries the rest. */
const chipLabel = (label: string) => `@${label}`;

/**
 * An Agent mention chip that peeks at the Agent's card on hover, focus or long press, like the
 * avatar beside the Agent's messages, and opens the profile panel when pressed. `label` is the
 * resolved mention label the chip shows.
 */
export function AgentMentionChip({
  agentId,
  label,
  className,
  onOpenProfile,
  children,
}: {
  agentId: string;
  label: string;
  className?: string;
  onOpenProfile: OpenAgentProfile;
  children: ReactNode;
}) {
  return (
    <AgentHoverCard
      agentId={agentId}
      name={label}
      label={chipLabel(label)}
      inline
      trigger={children}
      triggerClassName={openableChipClassName(className)}
      onOpenProfile={onOpenProfile}
    />
  );
}

/**
 * A person mention chip that peeks at the member's card on hover, focus or long press, like the
 * channel header's faces, and opens their profile panel when pressed.
 */
export function PersonMentionChip({
  userId,
  label,
  className,
  onOpenProfile,
  children,
}: {
  userId: string;
  label: string;
  className?: string;
  onOpenProfile: OpenPersonProfile;
  children: ReactNode;
}) {
  return (
    <PersonHoverCard
      label={chipLabel(label)}
      inline
      trigger={children}
      triggerClassName={openableChipClassName(className)}
      onPress={() => onOpenProfile(userId)}
      userId={userId}
      name={label}
    />
  );
}
