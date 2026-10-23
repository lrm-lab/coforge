import { PERSON_PICTURES } from "#src/lib/person-picture";

export interface AvatarPreset {
  id: string;
  /** The picture's number, shown as "Avatar 01". */
  number: string;
  url: string;
}

/** The pictures the platform offers as an avatar (the cartoon people), served from `public/avatars`. */
export const avatarPresets: AvatarPreset[] = PERSON_PICTURES.map(({ id, url }, index) => ({
  id,
  number: String(index + 1).padStart(2, "0"),
  url,
}));

const PRESET_REFERENCE_PREFIX = "preset:";
const presetsById = new Map(avatarPresets.map((preset) => [preset.id, preset]));

export function isAvatarPresetId(id: string): boolean {
  return presetsById.has(id);
}

/** What a chosen preset is stored as in place of an image object key: the picture already ships
 * with the app, so choosing it copies nothing into the image store. */
export function avatarPresetReference(id: string): string {
  return `${PRESET_REFERENCE_PREFIX}${id}`;
}

/** Whether a stored avatar key is a preset reference rather than an image object key. A reference
 * names no stored object, whether or not the app still ships its picture. */
export function isAvatarPresetReference(storedKey: string): boolean {
  return storedKey.startsWith(PRESET_REFERENCE_PREFIX);
}

/** The app's own URL for a stored preset reference; null for an object key or an unknown preset. */
export function avatarPresetUrl(storedKey: string): string | null {
  if (!isAvatarPresetReference(storedKey)) return null;
  return presetsById.get(storedKey.slice(PRESET_REFERENCE_PREFIX.length))?.url ?? null;
}
