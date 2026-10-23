import { fnv1a } from "#src/lib/stable-hash";

/** The cartoon people, the only pictures the platform offers as an avatar (Frank, 2026-10-24). */
const PERSON_IDS = ["person-1", "person-2", "person-3", "person-4"] as const;

/** Version of the cartoon people's files (`person-<n>-<version>.webp`, served from
 * `public/avatars`). A changed picture ships under a new file name because browsers cache by URL:
 * bump it and rename the files. */
const PERSON_PICTURE_VERSION = 1;

const PERSON_PICTURE_DIR = "/avatars/";

/** The cartoon people, in preset order: the id a stored preset reference names and the picture
 * `public/avatars` serves for it. Pure data: the server, the browser and the avatar presets all
 * read this one definition. */
export const PERSON_PICTURES: readonly { id: string; url: string }[] = PERSON_IDS.map((id) => ({
  id,
  url: `${PERSON_PICTURE_DIR}${id}-${PERSON_PICTURE_VERSION}.webp`,
}));

/** Whether a picture URL is one of the cartoon people. For presentation only: a cartoon person is
 * drawn as a sticker like an Agent's mascot (`isStickerPicture`). */
export function isPersonPicture(url: string | null | undefined): boolean {
  return typeof url === "string" && url.startsWith(`${PERSON_PICTURE_DIR}person-`);
}

/** The current URL of the cartoon person a stored picture URL names, from its id alone (a stored
 * `/avatars/person-2-1.webp` is `person-2` whatever version it was written under), so a version
 * bump cannot strand it. Null when the URL names no cartoon person this build ships. */
export function currentPersonPictureUrl(url: string): string | null {
  const id = /^\/avatars\/(person-\d+)-\d+\.webp$/.exec(url)?.[1];
  return PERSON_PICTURES.find((picture) => picture.id === id)?.url ?? null;
}

/** The one resolver every surface uses for a person's picture, never null: the avatar they have
 * (an upload's URL, or the URL of the preset they chose), else the cartoon person a stable FNV-1a
 * hash of their user id chooses, the same on the server and in the browser, never stored. */
export function personAvatarUrl(userId: string, avatarUrl: string | null | undefined): string {
  return avatarUrl ?? PERSON_PICTURES[fnv1a(userId) % PERSON_PICTURES.length]!.url;
}
