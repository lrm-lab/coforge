import { expect, test } from "bun:test";

import { AppError, isAppErrorCode } from "#src/lib/app-error";

test("an AppError matches when its code is one of those asked for", () => {
  expect(isAppErrorCode(new AppError("NOT_FOUND"), "NOT_FOUND")).toBe(true);
  expect(isAppErrorCode(new AppError("CONFLICT"), "ACCESS_DENIED", "CONFLICT")).toBe(true);
});

test("an AppError with another code does not match", () => {
  expect(isAppErrorCode(new AppError("CONFLICT"), "NOT_FOUND")).toBe(false);
});

test("anything that is not an AppError does not match", () => {
  expect(isAppErrorCode(new Error("NOT_FOUND"), "NOT_FOUND")).toBe(false);
  expect(isAppErrorCode({ code: "NOT_FOUND" }, "NOT_FOUND")).toBe(false);
  expect(isAppErrorCode(undefined, "NOT_FOUND")).toBe(false);
});

test("an AppError serialized across a Server Function boundary still matches by code", () => {
  // The client sees a plain Error whose message carries the code; `isAppError` revives it.
  const revived = new Error(new AppError("ACCESS_DENIED").message);
  expect(isAppErrorCode(revived, "ACCESS_DENIED")).toBe(true);
});

test("a false answer still leaves an AppError with another code", () => {
  const error: AppError | null = new AppError("CONFLICT");
  if (isAppErrorCode(error, "NOT_FOUND")) throw new Error("unexpected match");
  // Type-level: `error` is still `AppError | null` here, so its code can be read.
  expect(error?.code).toBe("CONFLICT");
});
