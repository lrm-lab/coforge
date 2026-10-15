/**
 * Standard base64 (RFC 4648 §4), written out rather than delegated: this module also reaches the
 * browser bundle, which has no `Buffer`, and `Uint8Array.prototype.toBase64` is too new to rely
 * on. Both directions are exact inverses and `decodeBase64` is strict — the only accepted input is
 * what `encodeBase64` (or `Buffer.prototype.toString("base64")`) produces for some byte string, so
 * a payload cannot arrive with two spellings and be compared as if it had one.
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const ENCODING_DIGITS = Uint8Array.from({ length: ALPHABET.length }, (_, index) =>
  ALPHABET.charCodeAt(index),
);
const ASCII_DECODER = new TextDecoder();

const DIGITS = new Int16Array(128).fill(-1);
for (let digit = 0; digit < ALPHABET.length; digit++) DIGITS[ALPHABET.charCodeAt(digit)] = digit;

const DECODE_PAIRS = new Int16Array(128 * 128).fill(-1);
for (let first = 0; first < ALPHABET.length; first++) {
  for (let second = 0; second < ALPHABET.length; second++)
    DECODE_PAIRS[(ALPHABET.charCodeAt(first) << 7) | ALPHABET.charCodeAt(second)] =
      (first << 6) | second;
}

export function encodeBase64(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";
  const encoded = new Uint8Array(Math.ceil(bytes.length / 3) * 4);
  let offset = 0;
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]!;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    encoded[offset++] = ENCODING_DIGITS[first >> 2]!;
    encoded[offset++] = ENCODING_DIGITS[((first & 0x03) << 4) | ((second ?? 0) >> 4)]!;
    encoded[offset++] =
      second === undefined ? 61 : ENCODING_DIGITS[((second & 0x0f) << 2) | ((third ?? 0) >> 6)]!;
    encoded[offset++] = third === undefined ? 61 : ENCODING_DIGITS[third & 0x3f]!;
  }
  // Every output byte is ASCII, so non-streaming UTF-8 decoding preserves the base64 spelling.
  return ASCII_DECODER.decode(encoded);
}

export function decodeBase64(value: string): Uint8Array {
  // A base64 string is a whole number of 4-character groups; anything else is not one at all.
  if (value.length % 4 !== 0) throw new Error("Invalid base64 length");
  const bytes = new Uint8Array((value.length / 4) * 3);
  let offset = 0;
  const trailingPadding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  let index = 0;
  for (; index + 4 < value.length; index += 4) {
    const first = value.charCodeAt(index);
    const second = value.charCodeAt(index + 1);
    const third = value.charCodeAt(index + 2);
    const fourth = value.charCodeAt(index + 3);
    // Earlier groups cannot contain padding, even when another character is invalid.
    if (third === 61 || fourth === 61) throw new Error("Invalid base64 padding");
    if ((first | second | third | fourth) > 127) throw new Error("Invalid base64 character");
    const high = DECODE_PAIRS[(first << 7) | second]!;
    const low = DECODE_PAIRS[(third << 7) | fourth]!;
    if ((high | low) < 0) throw new Error("Invalid base64 character");
    const group = (high << 12) | low;
    bytes[offset++] = (group >> 16) & 0xff;
    bytes[offset++] = (group >> 8) & 0xff;
    bytes[offset++] = group & 0xff;
  }
  if (index < value.length) {
    const padding = trailingPadding;
    let group = 0;
    for (let position = 0; position < 4 - padding; position++) {
      const digit = DIGITS[value.charCodeAt(index + position)];
      if (digit === undefined || digit < 0) throw new Error("Invalid base64 character");
      group = (group << 6) | digit;
    }
    // Refuse a group whose unused trailing bits are set: `Zh==` decodes to `f` the way `Zg==` does,
    // so accepting it would admit a second spelling of the same bytes.
    if (padding === 2 && (group & 0x0f) !== 0) throw new Error("Invalid base64 padding");
    if (padding === 1 && (group & 0x03) !== 0) throw new Error("Invalid base64 padding");
    group <<= padding * 6;
    bytes[offset++] = (group >> 16) & 0xff;
    if (padding < 2) bytes[offset++] = (group >> 8) & 0xff;
    if (padding < 1) bytes[offset++] = group & 0xff;
  }
  return bytes.subarray(0, offset);
}
