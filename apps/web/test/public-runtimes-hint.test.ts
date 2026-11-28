import { afterEach, describe, expect, test } from "bun:test";

import {
  publicRuntimesHint,
  publicRuntimesOwnerName,
} from "#src/features/computers/public-runtimes-hint";
import { overwriteGetLocale } from "#src/paraglide/runtime";

afterEach(() => {
  overwriteGetLocale(() => "en");
});

describe("publicRuntimesOwnerName", () => {
  test("returns undefined when computer is undefined, ownership is unknown, or owned by current user", () => {
    expect(publicRuntimesOwnerName(undefined)).toBeUndefined();
    expect(
      publicRuntimesOwnerName({
        creator: { displayName: "FrankAn" },
      }),
    ).toBeUndefined();
    expect(
      publicRuntimesOwnerName({
        ownedByCurrentUser: true,
        creator: { displayName: "FrankAn" },
      }),
    ).toBeUndefined();
    expect(
      publicRuntimesOwnerName({
        ownedByCurrentUser: false,
        creator: null,
      }),
    ).toBeUndefined();
  });

  test("resolves trimmed displayName or localized unnamed fallback for non-owners", () => {
    overwriteGetLocale(() => "en");
    expect(
      publicRuntimesOwnerName({
        ownedByCurrentUser: false,
        creator: { displayName: "  FrankAn  " },
      }),
    ).toBe("FrankAn");
    expect(
      publicRuntimesOwnerName({
        ownedByCurrentUser: false,
        creator: { displayName: "   " },
      }),
    ).toBe("Unnamed");

    overwriteGetLocale(() => "zh-CN");
    expect(
      publicRuntimesOwnerName({
        ownedByCurrentUser: false,
        creator: { displayName: null },
      }),
    ).toBe("未命名");
  });
});

describe("publicRuntimesHint", () => {
  test("formats exact English and Chinese copy for non-owners and stays empty for owners", () => {
    const nonOwner = {
      ownedByCurrentUser: false,
      creator: { displayName: "FrankAn" },
    };
    const longOwner = {
      ownedByCurrentUser: false,
      creator: { displayName: "Alexander Maximilian Chen (Platform Infra)" },
    };

    overwriteGetLocale(() => "en");
    expect(publicRuntimesHint(nonOwner)).toBe("Showing runtimes FrankAn has made public.");
    expect(publicRuntimesHint(longOwner)).toBe(
      "Showing runtimes Alexander Maximilian Chen (Platform Infra) has made public.",
    );
    expect(
      publicRuntimesHint({
        ownedByCurrentUser: true,
        creator: { displayName: "FrankAn" },
      }),
    ).toBeUndefined();

    overwriteGetLocale(() => "zh-CN");
    expect(publicRuntimesHint(nonOwner)).toBe("仅显示 FrankAn 公开的运行时");
    expect(publicRuntimesHint(longOwner)).toBe(
      "仅显示 Alexander Maximilian Chen (Platform Infra) 公开的运行时",
    );
  });
});
