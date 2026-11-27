import { describe, expect, test } from "bun:test";
import {
  buildTimeZonePickerOptions,
  formatOffsetSearchAliases,
} from "#src/features/settings/time-zone-options";

describe("formatOffsetSearchAliases", () => {
  test("formats UTC zero and signed whole/fractional hour offsets", () => {
    expect(formatOffsetSearchAliases(0)).toBe("UTC+0 GMT+0 GMT+00:00 GMT");
    expect(formatOffsetSearchAliases(480)).toBe("+8 UTC+8 GMT+8 GMT+08:00");
    expect(formatOffsetSearchAliases(-300)).toBe("-5 UTC-5 GMT-5 GMT-05:00");
    expect(formatOffsetSearchAliases(330)).toBe("+5:30 UTC+5:30 GMT+5:30 GMT+05:30");
    expect(formatOffsetSearchAliases(345)).toBe("+5:45 UTC+5:45 GMT+5:45 GMT+05:45");
  });
});

describe("buildTimeZonePickerOptions", () => {
  const fixedDate = new Date("2026-01-15T12:00:00Z");

  test("puts system first with system keyword and sorts zones by offset then label", () => {
    const options = buildTimeZonePickerOptions({
      locale: "en",
      systemLabel: "System",
      zones: ["Asia/Tokyo", "UTC", "Asia/Shanghai", "America/New_York"],
      now: fixedDate,
    });

    expect(options[0]).toEqual({
      id: "system",
      label: "System",
      offsetMinutes: 0,
      keywords: "system",
    });
    expect(options.slice(1).map((option) => option.id)).toEqual([
      "America/New_York",
      "UTC",
      "Asia/Shanghai",
      "Asia/Tokyo",
    ]);
    expect(options.find((option) => option.id === "Asia/Shanghai")?.label).toBe(
      "(UTC+08:00) Shanghai - Asia/Shanghai",
    );
  });

  test("adds localized longGeneric names and offset aliases for en and zh-CN", () => {
    const enOptions = buildTimeZonePickerOptions({
      locale: "en",
      systemLabel: "System",
      zones: ["Asia/Shanghai", "America/Los_Angeles"],
      now: fixedDate,
    });
    const zhOptions = buildTimeZonePickerOptions({
      locale: "zh-CN",
      systemLabel: "跟随系统",
      zones: ["Asia/Shanghai", "America/Los_Angeles"],
      now: fixedDate,
    });

    expect(zhOptions[0]).toEqual({
      id: "system",
      label: "跟随系统",
      offsetMinutes: 0,
      keywords: "system",
    });

    const shanghaiEn = enOptions.find((option) => option.id === "Asia/Shanghai");
    const shanghaiZh = zhOptions.find((option) => option.id === "Asia/Shanghai");
    expect(shanghaiEn?.keywords).toContain("UTC+8");
    expect(shanghaiEn?.keywords).toContain("China");
    expect(shanghaiZh?.keywords).toContain("UTC+8");
    expect(shanghaiZh?.keywords).toContain("中国");
  });

  test("preserves an unknown saved time zone right after system", () => {
    const options = buildTimeZonePickerOptions({
      locale: "en",
      systemLabel: "System",
      selectedZone: "US/Eastern",
      zones: ["UTC", "Asia/Shanghai"],
      now: fixedDate,
    });

    expect(options.slice(0, 2)).toEqual([
      { id: "system", label: "System", offsetMinutes: 0, keywords: "system" },
      { id: "US/Eastern", label: "US/Eastern", offsetMinutes: 0, keywords: "US/Eastern" },
    ]);
  });
});
