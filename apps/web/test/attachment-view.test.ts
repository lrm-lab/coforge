import { expect, test } from "bun:test";

import { attachmentView } from "#src/server/attachments/attachment-view.server";

const row = {
  id: "a1",
  fileName: "shot.png",
  contentType: "image/png",
  sizeBytes: 5,
  imageWidth: null,
  imageHeight: null,
  objectKey: "workspaces/w/attachments/a1/original",
};

test("carries a signed preview URL for an inline image when delivery is configured", () => {
  const view = attachmentView(row, {
    signedUrl: (objectKey) => {
      expect(objectKey).toBe(row.objectKey);
      return {
        url: "https://files-staging.coforge.cn/workspaces/w/attachments/a1/original?auth_key=1-2-0-3",
        expiresAt: new Date(0),
      };
    },
  });
  expect(view).toEqual({
    id: "a1",
    fileName: "shot.png",
    contentType: "image/png",
    sizeBytes: 5,
    previewUrl:
      "https://files-staging.coforge.cn/workspaces/w/attachments/a1/original?auth_key=1-2-0-3",
    thumbnailUrl: `https://files-staging.coforge.cn/workspaces/w/attachments/a1/original?auth_key=1-2-0-3&x-oss-process=${TIER.thumbnailUrl}`,
    iconUrl: `https://files-staging.coforge.cn/workspaces/w/attachments/a1/original?auth_key=1-2-0-3&x-oss-process=${TIER.iconUrl}`,
    largeUrl: `https://files-staging.coforge.cn/workspaces/w/attachments/a1/original?auth_key=1-2-0-3&x-oss-process=${TIER.largeUrl}`,
  });
});

test("omits the preview URL for a non-image content type even when delivery is configured", () => {
  const view = attachmentView(
    { ...row, contentType: "application/pdf", fileName: "doc.pdf" },
    {
      signedUrl: () => {
        throw new Error("must not sign a URL for a non-inline-image content type");
      },
    },
  );
  expect(view).toEqual({
    id: "a1",
    fileName: "doc.pdf",
    contentType: "application/pdf",
    sizeBytes: 5,
  });
  expect(view).not.toHaveProperty("previewUrl");
});

test("carries a signed preview URL for a video, stored as a video or as untyped bytes", () => {
  const delivery = {
    signedUrl: () => ({
      url: "https://files-staging.coforge.cn/v?auth_key=1",
      expiresAt: new Date(0),
    }),
  };
  for (const contentType of ["video/mp4", "application/octet-stream"]) {
    const view = attachmentView({ ...row, fileName: "clip.mp4", contentType }, delivery);
    expect(view.previewUrl).toBe("https://files-staging.coforge.cn/v?auth_key=1");
    expect(view).not.toHaveProperty("thumbnailUrl");
  }
});

test("never signs a video name stored as a document type", () => {
  const view = attachmentView(
    { ...row, fileName: "clip.mp4", contentType: "text/html" },
    {
      signedUrl: () => {
        throw new Error("must not sign a document the delivery origin would render");
      },
    },
  );
  expect(view).not.toHaveProperty("previewUrl");
});

test("omits the preview URL when delivery is not configured", () => {
  const view = attachmentView(row, null);
  expect(view).toEqual({
    id: "a1",
    fileName: "shot.png",
    contentType: "image/png",
    sizeBytes: 5,
  });
  expect(view).not.toHaveProperty("previewUrl");
});

test("never exposes objectKey on the returned view", () => {
  const view = attachmentView(row, null);
  expect(view).not.toHaveProperty("objectKey");
  const withDelivery = attachmentView(row, {
    signedUrl: () => ({
      url: "https://files-staging.coforge.cn/x?auth_key=1",
      expiresAt: new Date(0),
    }),
  });
  expect(withDelivery).not.toHaveProperty("objectKey");
});

test("omits the preview URL and keeps the row usable when signing throws", () => {
  const view = attachmentView(row, {
    signedUrl: () => {
      throw new Error("secret file unreadable");
    },
  });
  expect(view).toEqual({ id: "a1", fileName: "shot.png", contentType: "image/png", sizeBytes: 5 });
});

test("an inline image carries its intrinsic width and height together without exposing storage metadata", () => {
  const view = attachmentView({ ...row, imageWidth: 640, imageHeight: 360 }, null);
  expect(view).toEqual({
    id: "a1",
    fileName: "shot.png",
    contentType: "image/png",
    sizeBytes: 5,
    imageWidth: 640,
    imageHeight: 360,
  });
  expect(view).not.toHaveProperty("objectKey");
});

test("unknown or unusable image dimensions remain absent as a pair", () => {
  for (const dimensions of [
    { imageWidth: null, imageHeight: null },
    { imageWidth: 640, imageHeight: null },
    { imageWidth: 0, imageHeight: 360 },
    { imageWidth: 640, imageHeight: -1 },
  ]) {
    const view = attachmentView({ ...row, ...dimensions }, null);
    expect(view).not.toHaveProperty("imageWidth");
    expect(view).not.toHaveProperty("imageHeight");
  }
});

test("a non-inline attachment never supplies an image layout size", () => {
  const view = attachmentView(
    { ...row, contentType: "application/pdf", imageWidth: 640, imageHeight: 360 },
    null,
  );
  expect(view).not.toHaveProperty("imageWidth");
  expect(view).not.toHaveProperty("imageHeight");
});

const TIER = {
  thumbnailUrl: "image/auto-orient,1/resize,m_lfit,w_720,h_576,limit_1/format,webp/quality,q_80",
  iconUrl: "image/auto-orient,1/resize,m_fill,w_80,h_80,limit_1/format,webp/quality,q_80",
  largeUrl: "image/auto-orient,1/resize,m_lfit,w_2048,h_2048,limit_1/format,webp/quality,q_85",
};

test("an image OSS can resize gets three WebP tiers on its one signature", () => {
  const signed = "https://files.coforge.cn/workspaces/w/attachments/a1/original?auth_key=1-0-0-3";
  const delivery = { signedUrl: () => ({ url: signed, expiresAt: new Date(0) }) };
  const view = (contentType: string, imageWidth: number | null = 3000) =>
    attachmentView({ ...row, contentType, imageWidth, imageHeight: imageWidth }, delivery);
  const tiers = {
    thumbnailUrl: `${signed}&x-oss-process=${TIER.thumbnailUrl}`,
    iconUrl: `${signed}&x-oss-process=${TIER.iconUrl}`,
    largeUrl: `${signed}&x-oss-process=${TIER.largeUrl}`,
  };
  // Twice the message's 360×288 box, twice the Files row's 40px square, 2048 for the lightbox,
  // each in one fixed order so a picture in a tier is one CDN cache entry (task #212).
  for (const type of ["image/png", "image/jpeg", "image/webp"])
    expect(view(type)).toMatchObject({ previewUrl: signed, ...tiers });
  // Never enlarged (`limit_1`), so a small or unsized image takes the same URLs and still
  // becomes WebP.
  expect(view("image/png", 120)).toMatchObject(tiers);
  expect(view("image/png", null)).toMatchObject(tiers);
  // A browser cannot show a HEIC: no original preview, only its WebP tiers.
  for (const type of ["image/heic", "image/heif"]) {
    const heic = view(type, null);
    expect(heic).toMatchObject(tiers);
    expect(heic).not.toHaveProperty("previewUrl");
  }
  // Resizing a GIF keeps one frame: the original only.
  const gif = view("image/gif");
  expect(gif.previewUrl).toBe(signed);
  for (const tier of Object.keys(tiers)) expect(gif).not.toHaveProperty(tier);
  // No delivery, no signed URL to resize.
  expect(attachmentView({ ...row, imageWidth: 3000, imageHeight: 3000 }, null)).not.toHaveProperty(
    "thumbnailUrl",
  );
});
