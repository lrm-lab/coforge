import { expect, test } from "bun:test";
import { decodeBase64, encodeBase64 } from "./base64";

const RFC_4648_VECTORS: [string, string][] = [
  ["", ""],
  ["f", "Zg=="],
  ["fo", "Zm8="],
  ["foo", "Zm9v"],
  ["foob", "Zm9vYg=="],
  ["fooba", "Zm9vYmE="],
  ["foobar", "Zm9vYmFy"],
];

test("base64 matches the RFC 4648 §10 vectors in both directions", () => {
  for (const [plain, encoded] of RFC_4648_VECTORS) {
    expect(encodeBase64(new TextEncoder().encode(plain))).toBe(encoded);
    expect(new TextDecoder().decode(decodeBase64(encoded))).toBe(plain);
  }
});

test("base64 agrees with Buffer byte for byte over every length modulo three", () => {
  // 0..8 bytes covers all three remainder classes, and the 1 KiB case covers a payload that needs
  // more than one group plus padding.
  for (const length of [0, 1, 2, 3, 4, 5, 6, 7, 8, 1024]) {
    const bytes = crypto.getRandomValues(new Uint8Array(length));
    const encoded = encodeBase64(bytes);
    expect(encoded).toBe(Buffer.from(bytes).toString("base64"));
    expect(Array.from(decodeBase64(encoded))).toEqual(Array.from(bytes));
  }
});

test("base64 decoding refuses anything that is not one canonical spelling", () => {
  // Not a whole number of groups.
  expect(() => decodeBase64("Zg=")).toThrow();
  expect(() => decodeBase64("Zg")).toThrow();
  expect(() => decodeBase64("Zm9vY")).toThrow();
  // Padding outside the final group, or of the wrong width.
  expect(() => decodeBase64("Zg==Zg==")).toThrow();
  expect(() => decodeBase64("Z===")).toThrow();
  expect(() => decodeBase64("Zm9vYg=")).toThrow();
  // Characters outside the alphabet, including the URL-safe pair.
  expect(() => decodeBase64("Zm9v!m9v")).toThrow();
  expect(() => decodeBase64("Zm-v")).toThrow();
  expect(() => decodeBase64("Zm_v")).toThrow();
  // Trailing bits set: `Zh==` would decode to the same byte as `Zg==`, so it is refused rather
  // than silently accepted as a second spelling.
  expect(() => decodeBase64("Zh==")).toThrow();
  expect(() => decodeBase64("Zm9=")).toThrow();
});

test("base64 decoding preserves every byte across complete groups and padded tails", () => {
  for (const length of [1, 2, 3, 255, 256, 257]) {
    const expected = Uint8Array.from({ length }, (_, index) => index & 255);
    const encoded = Buffer.from(expected).toString("base64");
    const decoded = decodeBase64(encoded);
    expect(decoded).toEqual(expected);
    decoded[0] = 255;
    expect(decodeBase64(encoded)).toEqual(expected);
  }
});

test("base64 decoding retains canonical tail and character errors after complete groups", () => {
  for (const value of ["Zm9vZh==", "Zm9vZm9=", "Zg==!AAA"])
    expect(() => decodeBase64(value)).toThrow("Invalid base64 padding");
  for (const value of ["Zm9vZ===", "Zm9vZg=A", "Zm9v!AAA"])
    expect(() => decodeBase64(value)).toThrow("Invalid base64 character");
});

test("base64 decoding rejects nonalphabet ASCII and out-of-range Unicode in every group position", () => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
  const invalid = Array.from({ length: 128 }, (_, code) => String.fromCharCode(code)).filter(
    (character) => !alphabet.includes(character),
  );
  for (const code of [128, 255, 256, 768, 0x4e2d, 0xff21, 0xd800, 0xdfff, 0xffff])
    invalid.push(String.fromCharCode(code));
  for (const character of invalid) {
    for (let position = 0; position < 4; position++) {
      const value = "A".repeat(position) + character + "A".repeat(3 - position);
      expect(() => decodeBase64(value)).toThrow("Invalid base64 character");
    }
  }
  expect(() => decodeBase64("\ud83d\ude00AA")).toThrow("Invalid base64 character");
});
