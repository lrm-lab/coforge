import { expect, test } from "bun:test";

async function readPngHeader(path: string) {
  const png = new DataView(await Bun.file(new URL(path, import.meta.url)).arrayBuffer());
  return {
    width: png.getUint32(16),
    height: png.getUint32(20),
    colorType: png.getUint8(25),
  };
}

test("provides an installable standalone app manifest for iPhone, iPad, Android, and desktop", async () => {
  const manifest = await Bun.file(
    new URL("../public/manifest.webmanifest", import.meta.url),
  ).json();

  expect(manifest).toMatchObject({
    id: "/",
    name: "CoForge",
    short_name: "CoForge",
    lang: "en",
    start_url: "/",
    scope: "/",
    display: "standalone",
    launch_handler: { client_mode: ["navigate-existing", "auto"] },
    background_color: "#ffffff",
    theme_color: "#ffffff",
  });
  expect(manifest.short_name.length).toBeLessThanOrEqual(12);
  expect(manifest.description.length).toBeGreaterThan(0);
  expect(manifest.shortcuts.length).toBeGreaterThanOrEqual(2);
  expect(manifest.shortcuts.length).toBeLessThanOrEqual(4);
  expect(manifest.screenshots).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ form_factor: "narrow" }),
      expect.objectContaining({ form_factor: "wide" }),
    ]),
  );

  expect(manifest.icons).toContainEqual({
    src: "/apple-touch-icon.png",
    sizes: "180x180",
    type: "image/png",
  });
  expect(manifest.icons).toContainEqual({
    src: "/icon-192.png",
    sizes: "192x192",
    type: "image/png",
    purpose: "any",
  });
  expect(manifest.icons).toContainEqual({
    src: "/icon-512.png",
    sizes: "512x512",
    type: "image/png",
    purpose: "any",
  });
  expect(manifest.icons).toContainEqual({
    src: "/icon-512-maskable.png",
    sizes: "512x512",
    type: "image/png",
    purpose: "maskable",
  });

  const appleTouch = await readPngHeader("../public/apple-touch-icon.png");
  expect([appleTouch.width, appleTouch.height]).toEqual([180, 180]);
  expect(appleTouch.colorType).toBe(2);

  const icon192 = await readPngHeader("../public/icon-192.png");
  expect([icon192.width, icon192.height]).toEqual([192, 192]);

  const icon512 = await readPngHeader("../public/icon-512.png");
  expect([icon512.width, icon512.height]).toEqual([512, 512]);

  const maskable = await readPngHeader("../public/icon-512-maskable.png");
  expect([maskable.width, maskable.height]).toEqual([512, 512]);
  expect(maskable.colorType).toBe(2);

  const docsAppleTouch = await readPngHeader("../../docs/public/apple-touch-icon.png");
  expect([docsAppleTouch.width, docsAppleTouch.height]).toEqual([180, 180]);
  expect(docsAppleTouch.colorType).toBe(2);
});
