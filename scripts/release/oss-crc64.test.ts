import { expect, test } from "bun:test";

import { createCrc64, crc64Decimal } from "./oss-crc64";

const REFLECTED_POLYNOMIAL = 0xc96c5795d7870f42n;

function referenceCrc64(bytes: Uint8Array): bigint {
  let crc = 0xffffffffffffffffn;
  for (const byte of bytes) {
    crc ^= BigInt(byte);
    for (let bit = 0; bit < 8; bit += 1)
      crc = crc & 1n ? (crc >> 1n) ^ REFLECTED_POLYNOMIAL : crc >> 1n;
  }
  return crc ^ 0xffffffffffffffffn;
}

const ascii = (text: string) => new TextEncoder().encode(text);

test("the empty object is 0 and the standard vector is the published CRC-64/ECMA-182 value", () => {
  expect(crc64Decimal(new Uint8Array())).toBe("0");
  expect(crc64Decimal(ascii("123456789"))).toBe("11051210869376104954");
  expect(referenceCrc64(ascii("123456789"))).toBe(0x995dc9bbdf1939fan);
});

test("a value whose top bit is set keeps every one of its 64 bits in the decimal string", () => {
  const value = referenceCrc64(ascii("123456789"));
  expect(value >> 63n).toBe(1n);
  expect(crc64Decimal(ascii("123456789"))).toBe(value.toString());
  expect(value.toString()).toHaveLength(20);
});

test("the table implementation agrees with the bitwise reference on every length up to a page", () => {
  for (let length = 0; length <= 512; length += 1) {
    const bytes = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) bytes[index] = (index * 37 + length) & 0xff;
    expect(crc64Decimal(bytes)).toBe(referenceCrc64(bytes).toString());
  }
});

test("feeding the same bytes in pieces gives one object's checksum, as a multipart upload needs", () => {
  const whole = new Uint8Array(4096);
  for (let index = 0; index < whole.length; index += 1) whole[index] = (index * 91) & 0xff;
  for (const size of [1, 7, 1000, 4095]) {
    const streaming = createCrc64();
    for (let offset = 0; offset < whole.length; offset += size)
      streaming.update(whole.subarray(offset, Math.min(offset + size, whole.length)));
    expect(streaming.digest()).toBe(crc64Decimal(whole));
  }
});
