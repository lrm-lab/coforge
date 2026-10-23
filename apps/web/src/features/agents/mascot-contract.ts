/**
 * The mascots' shared vocabulary: which mascots exist and where their still pictures live. Pure
 * names and string builders, no imports and no side effects, so the server, the browser and the
 * asset generator (`assets/mascots/`) all read the one definition. The Rive runtime's names are in
 * `mascot-rive-contract.ts`, which the server does not import.
 */
export const MASCOT_IDS = ["blue", "orange", "pink", "green", "purple", "black", "yellow"] as const;
export type MascotId = (typeof MASCOT_IDS)[number];

/** Version of the still avatars (`mascot-<color>-<n>.webp`). A changed picture ships under a new
 * file name because browsers cache by URL: bump it and rebuild with `bun run build:mascots`. */
export const STATIC_VERSION = 2;

const PICTURE_DIR = "/agent-avatars/";

/** The still picture of one mascot: its idle frame, 256 px, transparent. */
export function mascotStaticUrl(id: MascotId): string {
  return `${PICTURE_DIR}mascot-${id}-${STATIC_VERSION}.webp`;
}

/** Whether a picture URL is one this app serves for a mascot. For styling only (a mascot is drawn
 * without a tile); which mascot an Agent shows is its key, never read back from a URL. */
export function isMascotPicture(url: string | null | undefined): boolean {
  return typeof url === "string" && url.startsWith(PICTURE_DIR);
}
