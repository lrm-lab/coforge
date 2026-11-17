import { describe, expect, test } from "bun:test";
import {
  isDisplayableImageAttachment,
  isImageType,
  isInlineImage,
  isSvgImage,
} from "#src/lib/inline-image";
import { takesComments } from "#src/features/conversations/attachment-preview-kind";
import { attachmentMessageDisplayBody } from "#src/features/conversations/attachment-file-name";
import { imageDimensions } from "#src/server/attachments/attachment-image-dimensions.server";

describe("inline image whitelist and SVG CDN rules", () => {
  test("isInlineImage allows only png, jpeg, gif and webp", () => {
    expect(isInlineImage("image/png")).toBe(true);
    expect(isInlineImage("image/jpeg")).toBe(true);
    expect(isInlineImage("image/gif")).toBe(true);
    expect(isInlineImage("image/webp")).toBe(true);

    expect(isInlineImage("image/svg+xml")).toBe(false);
    expect(isInlineImage("image/heic")).toBe(false);
    expect(isInlineImage("image/tiff")).toBe(false);
    expect(isInlineImage("application/pdf")).toBe(false);
    expect(isSvgImage("image/svg+xml")).toBe(true);
  });

  test("isDisplayableImageAttachment allows inline images, WebP variants, and SVG only with signed previewUrl", () => {
    expect(isDisplayableImageAttachment({ contentType: "image/png" })).toBe(true);
    expect(
      isDisplayableImageAttachment({
        contentType: "image/heic",
        thumbnailUrl: "https://cdn.example.com/thumb.webp",
      }),
    ).toBe(true);
    expect(
      isDisplayableImageAttachment({
        contentType: "image/heic",
        iconUrl: "https://cdn.example.com/icon.webp",
      }),
    ).toBe(true);
    expect(isDisplayableImageAttachment({ contentType: "image/heic" })).toBe(false);

    // Without a signed CDN previewUrl, SVG must fall back to a file card.
    expect(isDisplayableImageAttachment({ contentType: "image/svg+xml" })).toBe(false);
    expect(
      isDisplayableImageAttachment({
        contentType: "image/svg+xml",
        previewUrl: "https://files.example.com/workspaces/w/attachments/a/original?sig=1",
      }),
    ).toBe(true);
  });

  test("comments follow the image type alone, as the server asks without delivery URLs", () => {
    const file = (fileName: string, contentType: string) => ({
      fileName,
      contentType,
      sizeBytes: 1024,
    });
    const origin = "https://app.example.com";
    expect(takesComments(file("icon.svg", "image/svg+xml"), origin)).toBe(true);
    expect(takesComments(file("photo.heic", "image/heic"), origin)).toBe(true);
    expect(takesComments(file("photo.png", "image/png"), origin)).toBe(true);
    // Shown nowhere as an image, so nothing to comment on.
    expect(takesComments(file("photo.avif", "image/avif"), origin)).toBe(false);
  });

  test("the image types the product shows", () => {
    for (const type of ["image/png", "image/webp", "image/heic", "image/heif", "image/svg+xml"])
      expect(isImageType(type)).toBe(true);
    for (const type of ["image/avif", "image/bmp", "image/tiff", "application/pdf"])
      expect(isImageType(type)).toBe(false);
  });

  test("a filename-only body is hidden only when the SVG is drawn", () => {
    expect(
      attachmentMessageDisplayBody({
        body: "icon.svg",
        attachments: [{ fileName: "icon.svg", contentType: "image/svg+xml" }],
      }),
    ).toBe("icon.svg");

    expect(
      attachmentMessageDisplayBody({
        body: "icon.svg",
        attachments: [
          {
            fileName: "icon.svg",
            contentType: "image/svg+xml",
            previewUrl: "https://files.example.com/icon.svg?sig=1",
          },
        ],
      }),
    ).toBe("");
  });

  test("imageDimensions parses SVG width/height and viewBox", () => {
    const enc = new TextEncoder();
    expect(
      imageDimensions(
        enc.encode('<svg width="120px" height="80" viewBox="0 0 24 24"></svg>'),
        "image/svg+xml",
      ),
    ).toEqual({ imageWidth: 120, imageHeight: 80 });

    expect(imageDimensions(enc.encode('<svg viewBox="0 0 24 32"></svg>'), "image/svg+xml")).toEqual(
      { imageWidth: 24, imageHeight: 32 },
    );

    expect(
      imageDimensions(enc.encode('<svg width="100%" height="100%"></svg>'), "image/svg+xml"),
    ).toBeNull();
    // A relative size falls back to the viewBox; with neither, the message keeps its default box.
    expect(
      imageDimensions(
        enc.encode('<svg width="100%" height="100%" viewBox="0 0 400 100"></svg>'),
        "image/svg+xml",
      ),
    ).toEqual({ imageWidth: 400, imageHeight: 100 });
    expect(imageDimensions(enc.encode("<svg><circle r='4'/></svg>"), "image/svg+xml")).toBeNull();
  });
});
