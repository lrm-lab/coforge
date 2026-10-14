import ai01 from "#src/features/agents/avatar-pictures/v1/ai-01.webp?inline";
import ai02 from "#src/features/agents/avatar-pictures/v1/ai-02.webp?inline";
import ai03 from "#src/features/agents/avatar-pictures/v1/ai-03.webp?inline";
import ai04 from "#src/features/agents/avatar-pictures/v1/ai-04.webp?inline";
import ai05 from "#src/features/agents/avatar-pictures/v1/ai-05.webp?inline";
import ai06 from "#src/features/agents/avatar-pictures/v1/ai-06.webp?inline";
import ai07 from "#src/features/agents/avatar-pictures/v1/ai-07.webp?inline";
import ai08 from "#src/features/agents/avatar-pictures/v1/ai-08.webp?inline";
import ai09 from "#src/features/agents/avatar-pictures/v1/ai-09.webp?inline";
import ai10 from "#src/features/agents/avatar-pictures/v1/ai-10.webp?inline";
import ai11 from "#src/features/agents/avatar-pictures/v1/ai-11.webp?inline";
import ai12 from "#src/features/agents/avatar-pictures/v1/ai-12.webp?inline";
import ai13 from "#src/features/agents/avatar-pictures/v1/ai-13.webp?inline";
import ai14 from "#src/features/agents/avatar-pictures/v1/ai-14.webp?inline";
import ai15 from "#src/features/agents/avatar-pictures/v1/ai-15.webp?inline";
import ai16 from "#src/features/agents/avatar-pictures/v1/ai-16.webp?inline";
import ai17 from "#src/features/agents/avatar-pictures/v1/ai-17.webp?inline";
import ai18 from "#src/features/agents/avatar-pictures/v1/ai-18.webp?inline";
import ai19 from "#src/features/agents/avatar-pictures/v1/ai-19.webp?inline";
import ai20 from "#src/features/agents/avatar-pictures/v1/ai-20.webp?inline";
import ai21 from "#src/features/agents/avatar-pictures/v1/ai-21.webp?inline";
import ai22 from "#src/features/agents/avatar-pictures/v1/ai-22.webp?inline";
import ai23 from "#src/features/agents/avatar-pictures/v1/ai-23.webp?inline";
import ai24 from "#src/features/agents/avatar-pictures/v1/ai-24.webp?inline";

/** The pool the pictures below belong to. A new pool gets a new version and a new directory, and the
 * version travels in every stored copy's object key (`platformAvatarKey`), so a later replacement
 * finds exactly the avatars still holding a picture of the old pool. */
export const AGENT_AVATAR_POOL_VERSION = "v1";

/**
 * The twenty-four AI pictures a new Agent starts with. Vite's `?inline` embeds each one in the server
 * build as a `data:` URL, because the production image carries no source tree or `public/` to
 * read them from; under `bun test` the same import is a file path. Browsers never fetch these
 * files: a new Agent gets its own copy in the image store, so replacing or retiring a picture
 * here never changes an Agent that already has one.
 */
const pictures: string[] = [
  ai01,
  ai02,
  ai03,
  ai04,
  ai05,
  ai06,
  ai07,
  ai08,
  ai09,
  ai10,
  ai11,
  ai12,
  ai13,
  ai14,
  ai15,
  ai16,
  ai17,
  ai18,
  ai19,
  ai20,
  ai21,
  ai22,
  ai23,
  ai24,
];

/** The bytes of an inlined picture: a `data:` URL from the build, or an existing file path from
 * `bun test`. Anything else is a build that did not inline it, which must fail loudly rather than
 * create Agents with no picture. */
export async function decodeInlinedPicture(inlined: string): Promise<Uint8Array> {
  if (inlined.startsWith("data:")) {
    const separator = inlined.indexOf(",");
    if (separator < 0 || !inlined.slice(0, separator).endsWith(";base64"))
      throw new Error("An Agent avatar picture was inlined in an unexpected form");
    return Buffer.from(inlined.slice(separator + 1), "base64");
  }
  const file = Bun.file(inlined);
  if (!(await file.exists()))
    throw new Error("An Agent avatar picture was not inlined by the build");
  return file.bytes();
}

/** One picture drawn at random. `random` is injectable so a test can walk the whole list; it must
 * return a value in [0, 1). */
export async function randomAgentAvatarPicture(
  random: () => number = Math.random,
): Promise<{ id: string; file: File }> {
  const index = Math.min(Math.floor(random() * pictures.length), pictures.length - 1);
  const id = `ai-${String(index + 1).padStart(2, "0")}`;
  const bytes = await decodeInlinedPicture(pictures[index]!);
  return { id, file: new File([new Uint8Array(bytes)], `${id}.webp`, { type: "image/webp" }) };
}
