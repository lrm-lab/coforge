import { fnv1a } from "#src/lib/stable-hash";

/** The cartoon people, the only pictures the platform offers as an avatar: Frank's ten round
 * portraits (2026-10-29), five men then five women, the order the pickers show them in.
 * `person-1` to `person-4` named the four earlier figures (2026-10-24) and now name the portrait
 * closest to each, so a stored `preset:person-<n>` or picture URL keeps a look-alike face. */
const PERSON_IDS = [
  "person-5",
  "person-2",
  "person-4",
  "person-6",
  "person-7",
  "person-8",
  "person-3",
  "person-9",
  "person-10",
  "person-1",
] as const;

/** The faces a person who never chose one is given: the four that replaced the earlier figures,
 * so nobody's default face changes to an unrelated one. Choosing is offered when a person names
 * themselves on first sign-in, and in their profile. */
const DEFAULT_PERSON_IDS = ["person-1", "person-2", "person-3", "person-4"] as const;

/** Version of the cartoon people's files (`person-<n>-<version>.webp`, served from
 * `public/avatars`). A changed picture ships under a new file name because browsers cache by URL:
 * bump it and rename the files. */
const PERSON_PICTURE_VERSION = 2;

const PERSON_PICTURE_DIR = "/avatars/";

const personPictureUrl = (id: string) =>
  `${PERSON_PICTURE_DIR}${id}-${PERSON_PICTURE_VERSION}.webp`;

/** The cartoon people, in preset order: the id a stored preset reference names and the picture
 * `public/avatars` serves for it. Pure data: the server, the browser and the avatar presets all
 * read this one definition. */
export const PERSON_PICTURES: readonly { id: string; url: string }[] = PERSON_IDS.map((id) => ({
  id,
  url: personPictureUrl(id),
}));

/** Whether a picture URL is one of the cartoon people rather than an uploaded photo. */
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
 * (an upload's URL, or the URL of the preset they chose), else the default face a stable FNV-1a
 * hash of their user id chooses, the same on the server and in the browser, never stored. */
export function personAvatarUrl(userId: string, avatarUrl: string | null | undefined): string {
  return avatarUrl ?? personPictureUrl(defaultPersonPictureId(userId));
}

/** The id of the face a person who has not chosen one is shown. */
export function defaultPersonPictureId(userId: string): string {
  return DEFAULT_PERSON_IDS[fnv1a(userId) % DEFAULT_PERSON_IDS.length]!;
}
