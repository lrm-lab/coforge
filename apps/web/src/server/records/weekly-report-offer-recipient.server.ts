import { humanLabel } from "#src/lib/human-label";
import { workspaceUserAvatarUrl } from "#src/server/db/repositories/user-profile.repositories.server";

/**
 * One recipient on the weekly-report "offer-send" card, as the payload stores it: the name
 * teammates see (`humanLabel`, never the username), the user id (the card falls back to their
 * default cartoon person when the stored URL no longer resolves), and their avatar URL. The card
 * re-resolves a stored cartoon URL from its id when it reads the payload
 * (`parseRecordAssistantPayload`).
 */
export function offerSendRecipient(
  workspaceId: string,
  user: {
    id: string;
    username: string;
    displayName: string | null;
    avatarObjectKey: string | null;
  },
) {
  return {
    displayName: humanLabel(user),
    userId: user.id,
    avatarUrl: workspaceUserAvatarUrl(workspaceId, user.id, user.avatarObjectKey),
  };
}
