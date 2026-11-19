const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHORT_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlToBytes(value: string): Uint8Array | null {
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "==";
    const binary = atob(padded);
    if (binary.length !== 16) return null;
    const bytes = new Uint8Array(16);
    for (let index = 0; index < 16; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

export function encodeArtifactShortId(uuid: string): string {
  if (!UUID_PATTERN.test(uuid)) return uuid;
  const hex = uuid.replaceAll("-", "").toLowerCase();
  const bytes = new Uint8Array(16);
  for (let index = 0; index < 16; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytesToBase64Url(bytes);
}

export function decodeArtifactShortId(raw: string): string | null {
  if (UUID_PATTERN.test(raw)) return raw.toLowerCase();
  if (!SHORT_ID_PATTERN.test(raw)) return null;
  const bytes = base64UrlToBytes(raw);
  if (!bytes) return null;
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function publicArtifactPath(artifactId: string): string {
  return `/a/${encodeArtifactShortId(artifactId)}`;
}

export function buildForkPrompt(input: { title: string; url: string }): string {
  return `Please create a new artifact in this workspace forked from "${input.title}" (${input.url}). Preserve its structure and let me know when it is ready to customize.`;
}
