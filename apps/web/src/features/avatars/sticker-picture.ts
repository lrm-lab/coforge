import { isMascotPicture } from "#src/features/agents/mascot-contract";
import { isPersonPicture } from "#src/lib/person-picture";

/** Whether a picture URL is one of the platform's own sticker figures: an Agent's mascot or a
 * cartoon person. Both are drawn as an `AvatarSticker`; a photo a person uploaded is not, and
 * keeps the base `Avatar` tile. For presentation only. */
export function isStickerPicture(url: string | null | undefined): boolean {
  return isMascotPicture(url) || isPersonPicture(url);
}
