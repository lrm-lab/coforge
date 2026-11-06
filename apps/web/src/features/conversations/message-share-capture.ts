import { shareFileName, shareImageScale } from "./message-share-image-model";

/** How long the drawing must hold still to count as done, and the longest it is waited for. */
const STILL_MS = 150;
const STILL_LIMIT_MS = 2000;

/** Once `root` has stopped changing size, or the limit passes: a Task's title, an artifact's and
 * an image's box arrive after the first paint, and a measure or a capture must not beat them. */
function layoutStill(root: HTMLElement): Promise<void> {
  return new Promise((resolve) => {
    let quiet: ReturnType<typeof setTimeout>;
    const done = () => {
      clearTimeout(quiet);
      clearTimeout(limit);
      observer.disconnect();
      resolve();
    };
    const limit = setTimeout(done, STILL_LIMIT_MS);
    const observer = new ResizeObserver(() => {
      clearTimeout(quiet);
      quiet = setTimeout(done, STILL_MS);
    });
    // Its first report comes at once, and starts the quiet period.
    observer.observe(root);
  });
}

/** Once the fonts and every image under `root` are in, so a measure or a capture sees them. */
export async function shareContentReady(root: HTMLElement): Promise<void> {
  await document.fonts.ready;
  await Promise.all(
    [...root.querySelectorAll("img")].map(async (image) => {
      image.loading = "eager";
      // A broken image is drawn broken, as in the stream; it does not stop the capture.
      await image.decode().catch(() => undefined);
    }),
  );
  await layoutStill(root);
}

/** One card as a PNG, as sharp as the browser's canvas allows. The library is only fetched by
 * whoever generates an image. */
export async function shareCardPng(card: HTMLElement): Promise<Blob> {
  const { domToBlob } = await import("modern-screenshot");
  const scale = shareImageScale(card.offsetWidth, card.offsetHeight);
  return domToBlob(card, { scale, type: "image/png" });
}

/** Saves `blob` under `fileName` through the browser's own download. */
function saveBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  // Safari starts the download after this tick, and a revoked address would end it.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** One image as a PNG; several as one zip, since a browser asks before a burst of downloads. */
export async function downloadSharePages(pages: readonly Blob[]): Promise<void> {
  const [only, ...rest] = pages;
  if (only && rest.length === 0) return saveBlob(only, shareFileName(0, 1));
  const files = await Promise.all(
    pages.map(async (page, index) => [
      shareFileName(index, pages.length),
      new Uint8Array(await page.arrayBuffer()),
    ]),
  );
  const { zipSync } = await import("fflate");
  // PNGs are compressed already.
  const zip = zipSync(Object.fromEntries(files), { level: 0 });
  saveBlob(new Blob([zip], { type: "application/zip" }), "coforge-messages.zip");
}

/** Puts a page on the clipboard; false where the browser refuses. */
export async function copySharePage(page: Blob): Promise<boolean> {
  try {
    await navigator.clipboard.write([new ClipboardItem({ [page.type]: page })]);
    return true;
  } catch {
    return false;
  }
}
