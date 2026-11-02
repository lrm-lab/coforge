import { isMascotPicture } from "#src/features/agents/mascot-contract";

/** Whether a picture URL is one of the platform's own sticker figures: an Agent's mascot, drawn as
 * an `AvatarSticker`. A person's picture is round, a cartoon portrait as much as an uploaded
 * photo, and keeps the base `Avatar` tile. For presentation only. */
export function isStickerPicture(url: string | null | undefined): boolean {
  return isMascotPicture(url);
}
