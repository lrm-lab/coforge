export interface AvatarPreset {
  id: string;
  /** The picture's number, shown as "Avatar 01". */
  number: string;
  url: string;
}

/** The pictures the platform offers as an avatar, served from `public/avatars`. */
export const avatarPresets: AvatarPreset[] = Array.from({ length: 30 }, (_, index) => {
  const number = String(index + 1).padStart(2, "0");
  const id = `portrait-${number}`;
  return { id, number, url: `/avatars/${id}.webp` };
});

/** A preset as the file the avatar upload takes: choosing one is saved like an uploaded picture. */
export async function avatarPresetFile(
  preset: AvatarPreset,
  fetcher: (url: string) => Promise<Response> = fetch,
): Promise<File> {
  const response = await fetcher(preset.url);
  if (!response.ok) throw new Error(`Avatar ${preset.id} could not be read (${response.status})`);
  const blob = await response.blob();
  return new File([blob], `${preset.id}.webp`, { type: "image/webp" });
}
