/**
 * How a deleted (archived) identity's avatar is drawn, in one place so a deleted Agent looks the
 * same on every surface (`features/agents/deleted-agent.tsx` has the `ARCHIVED` badge beside it).
 */

/**
 * The deleted avatar background. Deliberately its own token rather than `bg-offline`:
 * `docs/design-tokens.md` documents `--color-offline` as the presence/status *dot* colour, and a
 * deleted identity is not a presence state. The value matches the light/dark offline greys so the
 * rendering is unchanged, but the name says what it means.
 */
export const DELETED_AVATAR_CLASS = "bg-avatar-deleted text-white";

/** A deleted identity's picture, which has no tile to grey (a sticker): the picture itself is greyed. */
export const DELETED_PICTURE_CLASS = "grayscale opacity-60";
