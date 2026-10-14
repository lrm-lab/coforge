import { expect, test } from "bun:test";

import { errorType } from "#src/server/errors/error-type.server";

test("a caught error is named by its class, never by its message", () => {
  class StorageUnavailable extends Error {
    override name = "StorageUnavailable";
  }
  expect(errorType(new TypeError("secret /path/to/file"))).toBe("TypeError");
  expect(errorType(new StorageUnavailable("bucket=private"))).toBe("StorageUnavailable");
});

test("something thrown that is not an Error is named by its typeof", () => {
  expect(errorType("a thrown string")).toBe("string");
  expect(errorType({ message: "looks like an error" })).toBe("object");
  expect(errorType(undefined)).toBe("undefined");
});
