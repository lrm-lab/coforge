import { expect, test } from "bun:test";
import { m } from "#src/paraglide/messages";
import { recordsErrorMessage } from "#src/features/records/records-error-message";
import { reportSaveFailure } from "#src/features/records/report-save-state";

const refusal = (code: string) => new Error(`Server function failed: COFORGE_APP_ERROR:${code}`);

test("our server's refusals are worded for the person, for each thing the request was for", () => {
  for (const context of ["save", "collect"] as const) {
    for (const code of ["NOT_FOUND", "ACCESS_DENIED", "INVALID_INPUT"]) {
      const text = recordsErrorMessage(refusal(code), context);
      expect(text).toBeTruthy();
      // Never the code itself.
      expect(text).not.toContain("COFORGE_APP_ERROR");
    }
  }
  expect(recordsErrorMessage(refusal("NOT_FOUND"), "save")).not.toBe(
    recordsErrorMessage(refusal("NOT_FOUND"), "collect"),
  );
});

test("a refusal it does not know says nothing, so the caller says only that it failed", () => {
  expect(recordsErrorMessage(refusal("SOMETHING_ELSE"), "save")).toBeUndefined();
  expect(recordsErrorMessage(new Error("socket hang up"), "save")).toBeUndefined();
  expect(recordsErrorMessage("not an error", "collect")).toBeUndefined();
});

test("a known refusal has no retry, anything else keeps it", () => {
  const retry = () => {};
  expect(reportSaveFailure(refusal("NOT_FOUND"), retry).retry).toBeUndefined();
  expect(reportSaveFailure(refusal("ACCESS_DENIED"), retry).retry).toBeUndefined();
  expect(reportSaveFailure(new TypeError("Failed to fetch"), retry)).toEqual({
    message: undefined,
    retry,
  });
});

test("a conflict is worded and keeps its retry", () => {
  const retry = () => {};
  const failure = reportSaveFailure(refusal("CONFLICT"), retry);
  expect(failure.message).toBe(m.records_report_conflict_reloaded());
  expect(failure.retry).toBe(retry);
  // Only a save can conflict.
  expect(recordsErrorMessage(refusal("CONFLICT"), "collect")).toBeUndefined();
});
