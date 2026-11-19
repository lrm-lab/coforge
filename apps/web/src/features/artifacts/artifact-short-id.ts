const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_INDEX = new Map(Array.from(BASE58_ALPHABET, (char, index) => [char, BigInt(index)]));
export const ARTIFACT_SHORT_ID_PATTERN = "[1-9A-HJ-NP-Za-km-z]{22}";
const SHORT_ID_EXACT = new RegExp(`^${ARTIFACT_SHORT_ID_PATTERN}$`);
const BASE = 58n;
const SHORT_ID_LENGTH = 22;
const MAX_UUID_INT = (1n << 128n) - 1n;

export function encodeArtifactShortId(uuid: string): string {
  if (!UUID_PATTERN.test(uuid)) return uuid;
  let value = BigInt(`0x${uuid.replaceAll("-", "")}`);
  const chars = Array.from<string>({ length: SHORT_ID_LENGTH });
  for (let index = SHORT_ID_LENGTH - 1; index >= 0; index -= 1) {
    chars[index] = BASE58_ALPHABET[Number(value % BASE)]!;
    value /= BASE;
  }
  return chars.join("");
}

export function decodeArtifactShortId(raw: string): string | null {
  if (UUID_PATTERN.test(raw)) return raw.toLowerCase();
  if (!SHORT_ID_EXACT.test(raw)) return null;
  let value = 0n;
  for (const char of raw) {
    const digit = BASE58_INDEX.get(char);
    if (digit === undefined) return null;
    value = value * BASE + digit;
  }
  if (value > MAX_UUID_INT) return null;
  const hex = value.toString(16).padStart(32, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function publicArtifactPath(artifactId: string): string {
  return `/a/${encodeArtifactShortId(artifactId)}`;
}
