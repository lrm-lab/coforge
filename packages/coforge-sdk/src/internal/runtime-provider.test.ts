import { describe, expect, test } from "bun:test";
import { RUNTIME_PROVIDER, parseRuntimeProvider, requireRuntimeProvider } from "./index";

describe("requireRuntimeProvider", () => {
  test("returns the provider a known value names", () => {
    expect(requireRuntimeProvider(RUNTIME_PROVIDER.COFORGE, "unused")).toBe(
      RUNTIME_PROVIDER.COFORGE,
    );
  });

  test("throws the caller's own message for a value this build does not know", () => {
    expect(() =>
      requireRuntimeProvider("not-a-provider", "Computer runtime has an invalid provider"),
    ).toThrow("Computer runtime has an invalid provider");
    expect(() => requireRuntimeProvider(undefined, "Invalid Agent lifecycle provider")).toThrow(
      "Invalid Agent lifecycle provider",
    );
    expect(() =>
      requireRuntimeProvider(42, "Computer reported an unknown runtime provider"),
    ).toThrow("Computer reported an unknown runtime provider");
  });

  test("agrees with parseRuntimeProvider about what counts as known", () => {
    expect(parseRuntimeProvider(RUNTIME_PROVIDER.COFORGE)).toBe(RUNTIME_PROVIDER.COFORGE);
    expect(parseRuntimeProvider("not-a-provider")).toBeUndefined();
  });
});

test("DSH is recognized as an external runtime without fast mode or usage scanning", async () => {
  const {
    RUNTIME_PROVIDER_USES_EXTERNAL_CLI,
    RUNTIME_PROVIDER_SUPPORTS_FAST_MODE,
    RUNTIME_PROVIDER_SUPPORTS_USAGE_SCAN,
  } = await import("./runtime-provider");
  const provider = requireRuntimeProvider("dsh", "DSH is missing from the runtime vocabulary");
  expect(RUNTIME_PROVIDER_USES_EXTERNAL_CLI[provider]).toBe(true);
  expect(RUNTIME_PROVIDER_SUPPORTS_FAST_MODE[provider]).toBe(false);
  expect(RUNTIME_PROVIDER_SUPPORTS_USAGE_SCAN[provider]).toBe(false);
});
