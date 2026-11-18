export function grayBitmap(width: number, height: number): Uint8Array {
  const row = width * 3 + ((4 - ((width * 3) % 4)) % 4);
  const bytes = new Uint8Array(54 + row * height);
  const view = new DataView(bytes.buffer);
  bytes.set([0x42, 0x4d]);
  view.setUint32(2, bytes.length, true);
  view.setUint32(10, 54, true);
  view.setUint32(14, 40, true);
  view.setInt32(18, width, true);
  view.setInt32(22, height, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 24, true);
  bytes.fill(0x80, 54);
  return bytes;
}

export const grayPng = (width: number, height: number) =>
  new Bun.Image(grayBitmap(width, height)).png().bytes();
