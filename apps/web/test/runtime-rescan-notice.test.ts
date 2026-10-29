import { describe, expect, test } from "bun:test";
import { runtimeRescanNotice } from "#src/features/computers/runtime-rescan-notice";

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
