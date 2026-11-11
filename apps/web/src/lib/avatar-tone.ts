/**
 * Deterministic placeholder styling for the official Avatar component
 * (`#src/components/base/avatar/avatar`) when there is no photo. Untitled's
 * Avatar always falls back to a neutral `bg-tertiary` tile; CoForge tints the
 * tile by a hash of the person's name via `contentClassName` so the same
 * person keeps the same colour on every screen without the server having to
 * store one.
 */

/** Written out whole: Tailwind generates only the class names it finds in the source, so a name
 * assembled at run time (`bg-avatar-${n}`) had no CSS and every initial sat on no tile. */
const TONES = [
  "bg-avatar-1",
  "bg-avatar-2",
  "bg-avatar-3",
  "bg-avatar-4",
  "bg-avatar-5",
  "bg-avatar-6",
] as const;

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * The glyph a pictureless avatar shows: the name's first letter or digit, as a whole grapheme
 * (`charAt(0)` split an emoji into half a surrogate pair, drawn as a box: task #86). Sender names
 * arrive as "@handle", and a name may lead with an emoji ("🦊 Fox" shows "F"); a name with no letter
 * at all shows its first grapheme ("🦊" shows "🦊").
 */
export function avatarInitial(name: string): string {
  let first: string | undefined;
  for (const { segment } of graphemes.segment(name.trim().replace(/^@+/, ""))) {
    if (/[\p{L}\p{N}]/u.test(segment)) return segment.toUpperCase();
    first ??= segment;
  }
  return first ?? "?";
}

export function avatarToneClassName(name: string): string {
  let hash = 0;
  for (const character of name) {
    hash = (hash * 31 + character.codePointAt(0)!) % 4093;
  }
  // The official Avatar colours its initials `text-quaternary`; on a tone tile they are white.
  return `${TONES[hash % TONES.length]} text-white *:text-white`;
}
