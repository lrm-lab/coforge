import { expect, test } from "bun:test";
import { diagnosticErrorCode, diagnosticErrorName } from "#src/platform/diagnostic-error-code";

class ProviderFailure extends Error {
  override name = "ProviderFailure";
  readonly code = "ECONNRESET";
}

test("an error's name ignores its code and never its message", () => {
  expect(diagnosticErrorName(new ProviderFailure("private detail"))).toBe("ProviderFailure");
  expect(diagnosticErrorName(new TypeError("x"))).toBe("TypeError");
  expect(diagnosticErrorName("not an error")).toBe("UnknownError");
  expect(diagnosticErrorName({ code: "EACCES" })).toBe("UnknownError");
});

test("an error's code prefers its code and falls back to its name", () => {
  expect(diagnosticErrorCode(new ProviderFailure("private detail"))).toBe("ECONNRESET");
  expect(diagnosticErrorCode({ code: "EACCES" })).toBe("EACCES");
  expect(diagnosticErrorCode(new TypeError("x"))).toBe("TypeError");
  expect(diagnosticErrorCode(undefined)).toBe("UnknownError");
});
