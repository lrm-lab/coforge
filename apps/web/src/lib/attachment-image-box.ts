/**
 * The boxes an attachment image is shown in, in CSS pixels, and how a message lays several out.
 * The message and the Files list draw them; the server sizes each image variant to twice its
 * largest box, for 2x screens (task #212). The message layout follows Raft's: a lone image keeps
 * its own shape within 416×288, never enlarged; several share a grid at most 360 wide. Opened, an
 * image shows its 2048 tier, not the original Raft shows: a phone photo of several MB then costs a
 * few hundred KB, and Download still gives the original.
 */
export const MESSAGE_IMAGE_MAX_WIDTH_PX = 416;
export const MESSAGE_IMAGE_MAX_HEIGHT_PX = 288;
/** A lone image whose size the server could not read: a 4:3 box. */
export const MESSAGE_IMAGE_FALLBACK_WIDTH_PX = 176;
/** The widest a group of images grows. */
export const MESSAGE_GALLERY_MAX_WIDTH_PX = 360;
/** The Files list's square (`size-10`). */
export const FILE_ROW_IMAGE_PX = 40;

type ImageSize = { imageWidth?: number | null; imageHeight?: number | null };

/** A known size, or undefined when either side is missing or not positive. */
function sizeOf({ imageWidth: width, imageHeight: height }: ImageSize) {
  return width && height && width > 0 && height > 0 ? { width, height } : undefined;
}

/** Wide (at least 2.2:1) and tall (at most 0.55:1) images are shown whole; the rest fill. */
export function imageShape(image: ImageSize): "wide" | "tall" | "normal" {
  const size = sizeOf(image);
  if (!size) return "normal";
  const ratio = size.width / size.height;
  return ratio >= 2.2 ? "wide" : ratio <= 0.55 ? "tall" : "normal";
}

/** A lone image's box: its own ratio scaled into 416×288, or the 4:3 fallback. */
export function singleImageBox(image: ImageSize) {
  const size = sizeOf(image);
  if (!size)
    return { width: `min(${MESSAGE_IMAGE_FALLBACK_WIDTH_PX}px, 100%)`, aspectRatio: "4 / 3" };
  const scale = Math.min(
    MESSAGE_IMAGE_MAX_WIDTH_PX / size.width,
    MESSAGE_IMAGE_MAX_HEIGHT_PX / size.height,
    1,
  );
  return {
    width: `min(${Math.max(1, Math.round(size.width * scale))}px, 100%)`,
    aspectRatio: `${size.width} / ${size.height}`,
  };
}

export type GalleryRow = { indexes: number[]; fit: ("cover" | "contain")[] };

/**
 * Rows for two or more images, by index: a wide image takes a row of its own; the images between
 * wide ones run on in rows of up to three, or two and two when exactly four. A normal image fills
 * its cell; a wide or tall one is shown whole.
 */
export function galleryRows(images: readonly ImageSize[]): GalleryRow[] {
  const rows: GalleryRow[] = [];
  const row = (indexes: number[]) => ({
    indexes,
    fit: indexes.map((index) =>
      imageShape(images[index]!) === "normal" ? ("cover" as const) : ("contain" as const),
    ),
  });
  let run: number[] = [];
  const flush = () => {
    const size = run.length === 4 ? 2 : 3;
    for (let start = 0; start < run.length; start += size)
      rows.push(row(run.slice(start, start + size)));
    run = [];
  };
  images.forEach((image, index) => {
    if (imageShape(image) !== "wide") return void run.push(index);
    flush();
    rows.push(row([index]));
  });
  flush();
  return rows;
}
