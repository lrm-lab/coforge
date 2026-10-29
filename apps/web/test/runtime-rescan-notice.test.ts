import { describe, expect, test } from "bun:test";
import { runtimeRescanNotice } from "#src/features/computers/runtime-rescan-notice";

const codex = { provider: "codex" as const };
const unusableDsh = { provider: "dsh" as const, unavailableCode: "start_failed" as const };

describe("runtimeRescanNotice", () => {
  test("says nothing before a rescan and after one that left every runtime usable", () => {
    expect(runtimeRescanNotice(undefined, [codex])).toEqual({ kind: "none" });
    expect(runtimeRescanNotice({ status: "refreshed" }, [codex])).toEqual({ kind: "none" });
  });

  test("a Computer that never answered is the timeout, not a runtime's failure", () => {
    expect(runtimeRescanNotice({ status: "timeout" }, [codex])).toEqual({ kind: "timeout" });
  });

  test("a failure the daemon reported keeps its own sentence", () => {
    expect(runtimeRescanNotice({ status: "error", message: "probe crashed" }, [codex])).toEqual({
      kind: "error",
      message: "probe crashed",
    });
    expect(runtimeRescanNotice({ status: "error" }, [codex])).toEqual({
      kind: "error",
      message: undefined,
    });
  });

  test("a rescan that ran and left a runtime unusable is partial", () => {
    expect(runtimeRescanNotice({ status: "refreshed" }, [codex, unusableDsh])).toEqual({
      kind: "partial",
    });
  });
});
