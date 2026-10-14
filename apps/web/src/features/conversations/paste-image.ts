/**
 * Browser-side image acquisition for the composer's paste path, split from
 * `composer-behavior.ts` (which stays DOM-free so it can be unit tested with
 * plain objects). Everything here needs real browser capabilities:
 * `fetch`, `createImageBitmap` and `<canvas>`.
 *
 * Two clipboard realities this covers:
 * - Tools like CleanShot X may hand the paste a raster type the browser or the
 *   server's inline whitelist (png/jpeg/gif/webp) does not serve inline (e.g.
 *   TIFF). Converting to PNG client-side keeps those screenshots previewable
 *   after upload instead of arriving as octet-stream files.
 * - Copying an image from a web page puts the image's URL on the clipboard
 *   (as `text/html` with an `<img>` or as a plain link) with no file bytes at
 *   all. The composer used to ignore those pastes silently, which read as a
 *   broken send button. Fetching the URL to a blob turns it into the same
 *   upload path the paperclip button uses; if the fetch fails (CORS, offline,
 *   not an image), the composer now says so instead of staying silent.
 */

/** Matches the server's inline-image whitelist in `attachment-response.server.ts`. */
export const INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** Extracts absolute http(s) image URLs from a paste's uri-list / HTML / plain-text payloads. */
export function imageUrlsFromPaste(
  clipboardData: {
    getData(type: string): string;
    types?: ArrayLike<string> | null;
  } | null,
): string[] {
  if (!clipboardData) return [];
  const urls: string[] = [];
  const push = (value: string | undefined | null) => {
    const trimmed = value?.trim();
    if (trimmed && /^https?:\/\//i.test(trimmed) && !urls.includes(trimmed)) urls.push(trimmed);
  };
  const types = Array.from(clipboardData.types ?? []);
  if (types.includes("text/uri-list")) {
    // uri-list: newline-separated entries, `#` lines are comments; only the first entry matters.
    const first = clipboardData
      .getData("text/uri-list")
      .split(/\r?\n/)
      .find((line) => line && !line.startsWith("#"));
    push(first);
  }
  if (types.includes("text/html")) {
    const html = clipboardData.getData("text/html");
    for (const match of html.matchAll(/<img\b[^>]*\bsrc\s*=\s*("|')(.*?)\1/gi)) push(match[2]);
    for (const match of html.matchAll(/src\s*=\s*"(https?:[^"\s]+)"/gi)) push(match[1]);
  }
  if (types.includes("text/plain")) {
    for (const line of clipboardData.getData("text/plain").split(/\r?\n/)) push(line);
  }
  return urls;
}

/** Reads a pasted file's raster content as a PNG re-encode, or `undefined` when it cannot be decoded. */
async function reencodeToPng(file: File): Promise<File | undefined> {
  try {
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
    bitmap.close();
    const blob = await new Promise<Blob | undefined>((resolve) =>
      canvas.toBlob((result) => resolve(result ?? undefined), "image/png"),
    );
    if (!blob) return undefined;
    return new File([blob], `${file.name.replace(/\.[^.]*$/, "") || "image"}.png`, {
      type: "image/png",
    });
  } catch {
    return undefined;
  }
}

/**
 * Rewrites a pasted image file the browser or server cannot serve inline into a PNG. Returns
 * the original file when it is already inline-ready, is not an image, or cannot be decoded
 * (uploading the original keeps the message sendable; the server just files it as non-inline).
 */
export async function ensureInlineImage(file: File): Promise<File> {
  if (!file.type.startsWith("image/") || INLINE_IMAGE_TYPES.has(file.type)) return file;
  const converted = await reencodeToPng(file);
  return converted ?? file;
}

/** Downloads an image URL into a File, or `undefined` when it is unreachable or not an image. */
export async function imageFileFromUrl(url: string): Promise<File | undefined> {
  try {
    const response = await fetch(url, { mode: "cors", credentials: "omit" });
    if (!response.ok) return undefined;
    const type = (response.headers.get("content-type") ?? "").split(";")[0].trim();
    if (!type.startsWith("image/")) return undefined;
    const blob = await response.blob();
    if (blob.size === 0) return undefined;
    const name = new URL(url).pathname.split("/").pop() || "image";
    return new File([blob], name, { type: type === "image/jpg" ? "image/jpeg" : type });
  } catch {
    return undefined;
  }
}
