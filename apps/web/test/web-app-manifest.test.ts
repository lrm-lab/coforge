import { expect, test } from "bun:test";

test("provides an installable standalone app manifest for iPhone and iPad", async () => {
  const manifest = await Bun.file(
    new URL("../public/manifest.webmanifest", import.meta.url),
  ).json();

  expect(manifest).toMatchObject({
    name: "CoForge",
    start_url: "/",
    display: "standalone",
  });
  expect(manifest.icons).toContainEqual({
    src: "/apple-touch-icon.png",
    sizes: "180x180",
    type: "image/png",
  });
  // The PNG's IHDR chunk carries its width and height, which must match the declared 180x180.
  const png = new DataView(
    await Bun.file(new URL("../public/apple-touch-icon.png", import.meta.url)).arrayBuffer(),
  );
  expect([png.getUint32(16), png.getUint32(20)]).toEqual([180, 180]);
});
