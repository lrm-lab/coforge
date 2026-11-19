import { expect, test } from "bun:test";
import {
  decodeArtifactShortId,
  encodeArtifactShortId,
  publicArtifactPath,
} from "#src/features/artifacts/artifact-short-id";

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";
const MAX_UUID = "ffffffff-ffff-ffff-ffff-ffffffffffff";
const SAMPLE_UUID = "11111111-1111-4111-8111-111111111111";
const RANDOM_UUID = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

test("encodeArtifactShortId and decodeArtifactShortId round-trip UUIDs losslessly in Base58", () => {
  for (const uuid of [ZERO_UUID, MAX_UUID, SAMPLE_UUID, RANDOM_UUID]) {
    const shortId = encodeArtifactShortId(uuid);
    expect(shortId).toHaveLength(22);
    expect(shortId).toMatch(/^[1-9A-HJ-NP-Za-km-z]{22}$/);
    expect(decodeArtifactShortId(shortId)).toBe(uuid);
  }
});

test("decodeArtifactShortId accepts full UUIDs and rejects invalid values", () => {
  expect(decodeArtifactShortId(SAMPLE_UUID)).toBe(SAMPLE_UUID);
  expect(decodeArtifactShortId(RANDOM_UUID.toUpperCase())).toBe(RANDOM_UUID);
  expect(decodeArtifactShortId("")).toBeNull();
  expect(decodeArtifactShortId("not-a-valid-id")).toBeNull();
  expect(decodeArtifactShortId("0".repeat(22))).toBeNull();
  expect(decodeArtifactShortId("O".repeat(22))).toBeNull();
  expect(decodeArtifactShortId("I".repeat(22))).toBeNull();
  expect(decodeArtifactShortId("l".repeat(22))).toBeNull();
  expect(decodeArtifactShortId("z".repeat(22))).toBeNull();
  expect(decodeArtifactShortId("a".repeat(23))).toBeNull();
});

test("publicArtifactPath builds /a/<shortId>", () => {
  const path = publicArtifactPath(RANDOM_UUID);
  expect(path).toBe(`/a/${encodeArtifactShortId(RANDOM_UUID)}`);
});
