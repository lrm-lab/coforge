import { describe, expect, test } from "bun:test";
import {
  runtimeDetectionStatus,
  runtimeRescanNotice,
} from "#src/features/computers/runtime-rescan-notice";

describe("runtimeRescanNotice", () => {
  test("says nothing before a rescan and after one that left every runtime usable", () => {
    expect(runtimeRescanNotice(undefined)).toEqual({ kind: "none" });
    expect(runtimeRescanNotice({ status: "refreshed" })).toEqual({ kind: "none" });
  });

  test("a Computer that never answered is the timeout, not a runtime's failure", () => {
    expect(runtimeRescanNotice({ status: "timeout" })).toEqual({ kind: "timeout" });
  });

  test("a failure the daemon reported keeps its own sentence", () => {
    expect(runtimeRescanNotice({ status: "error", message: "probe crashed" })).toEqual({
      kind: "error",
      message: "probe crashed",
    });
    expect(runtimeRescanNotice({ status: "error" })).toEqual({
      kind: "error",
      message: undefined,
    });
  });
});

describe("runtimeDetectionStatus", () => {
  test("returns none when neither auto-detecting nor rescanning", () => {
    expect(
      runtimeDetectionStatus({
        hasRuntimes: true,
        runtimeDetecting: false,
        rescanning: false,
        rescanButtonVisible: true,
      }),
    ).toBe("none");
    expect(
      runtimeDetectionStatus({
        hasRuntimes: false,
        runtimeDetecting: undefined,
        rescanning: false,
        rescanButtonVisible: false,
      }),
    ).toBe("none");
  });

  test("replaces the empty state with detecting_empty while empty and detecting", () => {
    expect(
      runtimeDetectionStatus({
        hasRuntimes: false,
        runtimeDetecting: true,
        rescanning: false,
        rescanButtonVisible: true,
      }),
    ).toBe("detecting_empty");
    expect(
      runtimeDetectionStatus({
        hasRuntimes: false,
        runtimeDetecting: false,
        rescanning: true,
        rescanButtonVisible: true,
      }),
    ).toBe("detecting_empty");
  });

  test("uses detecting_with_list for auto-detection with existing runtimes", () => {
    expect(
      runtimeDetectionStatus({
        hasRuntimes: true,
        runtimeDetecting: true,
        rescanning: false,
        rescanButtonVisible: true,
      }),
    ).toBe("detecting_with_list");
    expect(
      runtimeDetectionStatus({
        hasRuntimes: true,
        runtimeDetecting: true,
        rescanning: true,
        rescanButtonVisible: false,
      }),
    ).toBe("detecting_with_list");
  });

  test("uses rescanning_with_list when manual rescan button is showing progress", () => {
    expect(
      runtimeDetectionStatus({
        hasRuntimes: true,
        runtimeDetecting: false,
        rescanning: true,
        rescanButtonVisible: true,
      }),
    ).toBe("rescanning_with_list");
    expect(
      runtimeDetectionStatus({
        hasRuntimes: true,
        runtimeDetecting: true,
        rescanning: true,
        rescanButtonVisible: true,
      }),
    ).toBe("rescanning_with_list");
  });
});
