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

test("base64 encoding preserves complete groups and both tails within a bounded view", () => {
  const backing = new Uint8Array(3 + 4096 * 3 + 4).fill(211);
  for (let value = 0; value < 4096; value++) {
    const offset = 3 + value * 3;
    backing[offset] = value >> 4;
    backing[offset + 1] = ((value & 0x0f) << 4) | (value >> 8);
    backing[offset + 2] = value & 0xff;
  }
  const original = backing.slice();
  for (const tail of [0, 1, 2]) {
    const bytes = backing.subarray(3, backing.length - 4 - tail);
    expect(encodeBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
    expect(backing).toEqual(original);
  }
});

test("base64 decoding retains character and padding errors in earlier complete groups", () => {
  for (const prefix of ["", "Zm9v".repeat(128)]) {
    for (const character of ["!", "-", "_", "\u0000", "\u0080", "\u4e2d", "\ud800", "\uffff"]) {
      for (let position = 0; position < 4; position++) {
        const group = "A".repeat(position) + character + "A".repeat(3 - position);
        for (const suffix of ["AAAA", "Zg==", "Zm8="])
          expect(() => decodeBase64(prefix + group + suffix)).toThrow("Invalid base64 character");
      }
    }
    // Padding in an earlier group wins over a bad character in that same group. A bad character
    // in an earlier group still wins over invalid padding in a later one.
    for (const group of ["!A==", "!AA=", "\ud800A==", "A\uffffA="])
      expect(() => decodeBase64(prefix + group + "AAAA")).toThrow("Invalid base64 padding");
    expect(() => decodeBase64(prefix + "!AAA" + "Zh==")).toThrow("Invalid base64 character");
    expect(() => decodeBase64(prefix + "AAAA" + "Zh==")).toThrow("Invalid base64 padding");
  }
});

test("base64 decoding preserves every alphabet pair in earlier complete groups", () => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (const trailingPair of [false, true]) {
    let encoded = "";
    for (const first of alphabet) {
      for (const second of alphabet) {
        const pair = first + second;
        encoded += trailingPair ? "AA" + pair : pair + "AA";
      }
    }
    encoded += "Zm8=";
    const expected = new Uint8Array(Buffer.from(encoded, "base64"));
    const decoded = decodeBase64(encoded);
    expect(decoded).toEqual(expected);
    decoded.fill(0);
    expect(decodeBase64(encoded)).toEqual(expected);
  }
});

test("base64 encoding preserves large bounded views through every tail length", () => {
  const backing = Uint8Array.from({ length: 1048584 }, (_, index) => (index * 113) & 255);
  const original = backing.slice();
  for (const length of [16383, 16384, 16385, 1048575, 1048576, 1048577]) {
    const bytes = backing.subarray(3, 3 + length);
    expect(encodeBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
  }
  expect(backing).toEqual(original);
});

test("base64 encoding keeps results independent across empty and reused views", () => {
  const backing = Uint8Array.from({ length: 1029 }, (_, index) => index & 255);
  const bytes = backing.subarray(3, 1027);
  const expected = Buffer.from(bytes).toString("base64");
  const first = encodeBase64(bytes);
  expect(first).toBe(expected);
  expect(encodeBase64(new Uint8Array())).toBe("");
  bytes.fill(255);
  expect(encodeBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
  expect(first).toBe(expected);
  expect(encodeBase64(bytes.subarray(0, 1))).toBe("/w==");
  expect(encodeBase64(bytes.subarray(0, 2))).toBe("//8=");
  expect(encodeBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
});
