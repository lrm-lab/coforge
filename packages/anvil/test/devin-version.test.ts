import { expect, test } from "bun:test";
import {
  DEVIN_MIN_CLI_VERSION,
  assertDevinVersionSupported,
  devinVersionFromOutput,
  isDevinVersionUnsupported,
} from "#src/devin/version";

test("Devin reads the dotted version from `devin <version> (<hash>)`", () => {
  expect(devinVersionFromOutput("devin 3000.11.228 (053434014dbd)")).toBe("3000.11.228");
  expect(devinVersionFromOutput("devin 3000.11.100")).toBe("3000.11.100");
  expect(devinVersionFromOutput("devin (053434014dbd)")).toBeUndefined();
});

test("an older Devin release is refused and an unparseable one is not", () => {
  expect(isDevinVersionUnsupported("3000.11.100")).toBe(true);
  expect(isDevinVersionUnsupported("3000.11.228")).toBe(false);
  expect(isDevinVersionUnsupported("3000.12.0")).toBe(false);
  expect(isDevinVersionUnsupported("unknown")).toBe(false);
  expect(DEVIN_MIN_CLI_VERSION).toBe("3000.11.228");
});

test("the launch gate parses `devin --version` itself and refuses an older release", async () => {
  const readVersion = async (
    _command: readonly string[],
    versionFrom: (output: string) => string | undefined,
  ) => versionFrom("devin 3000.11.100 (053434014dbd)");
  await expect(assertDevinVersionSupported(["devin"], readVersion)).rejects.toThrow(
    "Devin CLI 3000.11.100 is unsupported",
  );

  const supported = async (
    _command: readonly string[],
    versionFrom: (output: string) => string | undefined,
  ) => versionFrom("devin 3000.11.228 (053434014dbd)");
  await expect(assertDevinVersionSupported(["devin"], supported)).resolves.toBeUndefined();
});
