/** The ring that parts the faces of an overlapping stack of avatars, and a pure white disc behind
 * an Agent's sticker (`.avatar-stack-face` in `styles.css`): a sticker has no fill of its own, so
 * without one the face below shows through, and its white edge expects white in dark mode too
 * (jing, task #132). */
export const AVATAR_STACK_RING = {
  thin: "avatar-stack-face ring-[1.5px] ring-bg-primary",
  regular: "avatar-stack-face ring-2 ring-bg-primary",
} as const;
