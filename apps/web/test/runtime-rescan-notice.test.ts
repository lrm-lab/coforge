import { describe, expect, test } from "bun:test";
import type { RuntimeCatalogRefreshResult } from "#src/features/computers/runtime-catalog-refresh-poll";
import {
  runtimeDetectionStatus,
  runtimeRescanNotice,
} from "#src/features/computers/runtime-rescan-notice";

describe("runtimeRescanNotice", () => {
  test("says nothing without a whole-Computer report", () => {
    expect(runtimeRescanNotice(undefined)).toEqual({ kind: "none" });
    expect(
      runtimeRescanNotice({ status: "refreshed", catalog: { provider: "kiro", models: [] } }),
    ).toEqual({ kind: "none" });
  });

  test("a Computer that never answered is the timeout, not a runtime's failure", () => {
    expect(runtimeRescanNotice({ status: "timeout" })).toEqual({ kind: "timeout" });
  });

  test("a request that could not start still shows the rescan error", () => {
    expect(runtimeRescanNotice({ status: "error" })).toEqual({ kind: "error" });
  });

  test("keeps login state independent of the refresh result and uses only visible reports", () => {
    const result = {
      status: "reported",
      refreshed: ["coforge"],
      failures: [
        { provider: "kiro", code: "unknown" },
        { provider: "codex", code: "start_failed", diagnostic: "launch diagnostic" },
      ],
    } satisfies RuntimeCatalogRefreshResult;
    expect(
      runtimeRescanNotice(result, {
        kiro: { provider: "kiro", state: "logged_out" },
        codex: { provider: "codex", state: "logged_in" },
        "claude-code": { provider: "claude-code", state: "logged_out" },
      }),
    ).toEqual({
      kind: "reported",
      refreshed: result.refreshed,
      failures: result.failures,
      signedOut: ["kiro"],
    });
    expect(runtimeRescanNotice(result)).toEqual({
      kind: "reported",
      refreshed: result.refreshed,
      failures: result.failures,
      signedOut: [],
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
