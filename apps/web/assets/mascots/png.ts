import { deflateSync, inflateSync } from "node:zlib";

/** Just enough PNG for the renderer's output: 8-bit, non-interlaced, RGB or RGBA. */
export interface Image {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel. */
  data: Uint8Array;
}

const SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

function chunks(png: Uint8Array): Map<string, Uint8Array[]> {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const out = new Map<string, Uint8Array[]>();
  let at = SIGNATURE.length;
  while (at < png.length) {
    const length = view.getUint32(at);
    const type = new TextDecoder().decode(png.subarray(at + 4, at + 8));
    out.set(type, [...(out.get(type) ?? []), png.subarray(at + 8, at + 8 + length)]);
    at += 12 + length;
  }
  return out;
}

const paeth = (a: number, b: number, c: number): number => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

export function decodePng(png: Uint8Array): Image {
  const parts = chunks(png);
  const header = parts.get("IHDR")?.[0];
  if (!header) throw new Error("not a PNG");
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const width = view.getUint32(0);
  const height = view.getUint32(4);
  const depth = header[8];
  const colorType = header[9];
  if (depth !== 8 || header[12] !== 0 || (colorType !== 6 && colorType !== 2))
    throw new Error("unsupported PNG");
  const channels = colorType === 6 ? 4 : 3;
  const compressed = Buffer.concat(parts.get("IDAT") ?? []);
  const raw = inflateSync(compressed);
  const stride = width * channels;
  const rows = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x] as number;
      const left = x >= channels ? (rows[y * stride + x - channels] as number) : 0;
      const up = y > 0 ? (rows[(y - 1) * stride + x] as number) : 0;
      const upLeft = y > 0 && x >= channels ? (rows[(y - 1) * stride + x - channels] as number) : 0;
      const add = [0, left, up, (left + up) >> 1, paeth(left, up, upLeft)][filter ?? 0] ?? 0;
      rows[y * stride + x] = (v + add) & 255;
    }
  }
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    for (let c = 0; c < 3; c++) data[i * 4 + c] = rows[i * channels + c] as number;
    data[i * 4 + 3] = channels === 4 ? (rows[i * 4 + 3] as number) : 255;
  }
  return { width, height, data };
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (crcTable[(c ^ b) & 255] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

export function encodePng(image: Image): Uint8Array {
  const { width, height, data } = image;
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8);
  const raw = new Uint8Array(height * (width * 4 + 1));
  for (let y = 0; y < height; y++)
    raw.set(data.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array()),
  ]);
}

/**
 * Recover transparency from two renders of the same frame, one over black and one over white:
 * a pixel's alpha is how much of the white backdrop it hides, and its colour is the black render
 * un-premultiplied. The renderer cannot write a transparent background itself.
 */
export function matte(onBlack: Image, onWhite: Image): Image {
  const data = new Uint8Array(onBlack.data.length);
  for (let i = 0; i < onBlack.data.length; i += 4) {
    let gap = 0;
    for (let c = 0; c < 3; c++)
      gap += (onWhite.data[i + c] as number) - (onBlack.data[i + c] as number);
    const alpha = Math.min(1, Math.max(0, 1 - gap / 3 / 255));
    for (let c = 0; c < 3; c++) {
      const v = (onBlack.data[i + c] as number) / (alpha || 1);
      data[i + c] = Math.min(255, Math.round(v));
    }
    data[i + 3] = Math.round(alpha * 255);
  }
  return { width: onBlack.width, height: onBlack.height, data };
}
