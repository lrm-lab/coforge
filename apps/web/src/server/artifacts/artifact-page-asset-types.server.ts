const ascii = (bytes: Uint8Array, at: number, text: string) =>
  text.length + at <= bytes.length &&
  [...text].every((char, i) => bytes[at + i] === char.charCodeAt(0));

function binaryType(bytes: Uint8Array): string | null {
  if (ascii(bytes, 1, "PNG") && bytes[0] === 0x89) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (ascii(bytes, 0, "GIF87a") || ascii(bytes, 0, "GIF89a")) return "image/gif";
  if (ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WEBP")) return "image/webp";
  if (ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WAVE")) return "audio/wav";
  if (ascii(bytes, 4, "ftyp")) {
    if (ascii(bytes, 8, "avif") || ascii(bytes, 8, "avis")) return "image/avif";
    return ascii(bytes, 8, "M4A ") ? "audio/mp4" : "video/mp4";
  }
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3)
    return "video/webm";
  if (ascii(bytes, 0, "OggS")) return "audio/ogg";
  if (ascii(bytes, 0, "ID3") || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0))
    return "audio/mpeg";
  if (ascii(bytes, 0, "%PDF-")) return "application/pdf";
  return null;
}

function textType(bytes: Uint8Array, name: string): string | null {
  if (bytes.includes(0)) return null;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  if (extension === "json") {
    try {
      JSON.parse(text);
    } catch {
      return null;
    }
    return "application/json";
  }
  return extension === "csv" ? "text/csv; charset=utf-8" : "text/plain; charset=utf-8";
}

export const sniffPageAsset = (bytes: Uint8Array, name: string): string | null =>
  binaryType(bytes) ?? textType(bytes, name);
