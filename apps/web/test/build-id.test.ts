import { expect, test } from "bun:test";

import { DEFAULT_BUILD_ID, readBuildId } from "#src/server/runtime/build-id.server";

test("the server build id trims the image value and has a development fallback", () => {
  expect(readBuildId({ COFORGE_BUILD_ID: "  abc123  " })).toBe("abc123");
  expect(readBuildId({ COFORGE_BUILD_ID: "" })).toBe(DEFAULT_BUILD_ID);
  expect(readBuildId({})).toBe(DEFAULT_BUILD_ID);
});
