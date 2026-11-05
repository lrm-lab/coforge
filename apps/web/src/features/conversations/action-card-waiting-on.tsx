import type { OpenPersonProfile } from "#src/features/agents/profile-panel/open-agent-profile";
import type { ActionCardActor } from "#src/server/conversations/action-card-view.server";
import { messageSlots } from "#src/lib/message-slots";
import { m } from "#src/paraglide/messages";
import { PersonMentionChip } from "./mention-chip-hover";
import { MENTION_CHIP_CLASS } from "./message-reference-chips";

/**
 * Whom a pending card waits on, for anyone but the asked person: their name as the @mention a
 * message would write it, in the same chip (Frank, 11-05, task #563: "换成艾特高亮"), in place
 * of the face and name the line had (task #521). As in a message, where the conversation can open
 * a person's profile the chip opens theirs and peeks at their card. The chip is words of the
 * sentence, so a long name runs on over the next lines, every word of it shown (task #554).
 */
export function WaitingOn({
  asked,
  onOpenPersonProfile,
}: {
  asked: ActionCardActor;
  onOpenPersonProfile?: OpenPersonProfile;
}) {
  const label = `@${asked.displayName}`;
  return (
    <p className="min-w-0 flex-1 text-xs text-tertiary wrap-anywhere">
      {messageSlots(m.action_card_choice_waiting, {
        name: onOpenPersonProfile ? (
          <PersonMentionChip
            userId={asked.id}
            label={asked.displayName}
            className={MENTION_CHIP_CLASS}
            onOpenProfile={onOpenPersonProfile}
          >
            {label}
          </PersonMentionChip>
        ) : (
          <span className={MENTION_CHIP_CLASS}>{label}</span>
        ),
      })}
    </p>
  );
}
