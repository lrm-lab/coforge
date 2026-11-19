import { expect, test } from "bun:test";
import {
  buildForkPrompt,
  decodeArtifactShortId,
  encodeArtifactShortId,
  publicArtifactPath,
} from "#src/features/artifacts/artifact-short-id";

const SAMPLE_UUID = "11111111-1111-4111-8111-111111111111";
const RANDOM_UUID = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

test("encodeArtifactShortId and decodeArtifactShortId round-trip UUIDs losslessly", () => {
  for (const uuid of [SAMPLE_UUID, RANDOM_UUID]) {
    const shortId = encodeArtifactShortId(uuid);
    expect(shortId).toHaveLength(22);
    expect(shortId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(decodeArtifactShortId(shortId)).toBe(uuid);
  }
});

test("decodeArtifactShortId accepts full UUIDs and rejects invalid values", () => {
  expect(decodeArtifactShortId(SAMPLE_UUID)).toBe(SAMPLE_UUID);
  expect(decodeArtifactShortId(RANDOM_UUID.toUpperCase())).toBe(RANDOM_UUID);
  expect(decodeArtifactShortId("")).toBeNull();
  expect(decodeArtifactShortId("not-a-valid-id")).toBeNull();
  expect(decodeArtifactShortId("a".repeat(23))).toBeNull();
});

test("publicArtifactPath builds /a/<shortId> and buildForkPrompt includes title and URL", () => {
  const path = publicArtifactPath(RANDOM_UUID);
  expect(path).toBe(`/a/${encodeArtifactShortId(RANDOM_UUID)}`);
  const prompt = buildForkPrompt({
    title: "Q4 Roadmap",
    url: `https://coforge.example${path}`,
  });
  expect(prompt).toContain("Q4 Roadmap");
  expect(prompt).toContain(`https://coforge.example${path}`);
});
