import { describe, expect, test } from "bun:test";

import { firstFieldError, formErrorMessage, visibleFieldError } from "./form-context";

describe("formErrorMessage", () => {
  test("extracts non-empty strings and Standard Schema issue messages", () => {
    expect(formErrorMessage("Username is taken")).toBe("Username is taken");
    expect(formErrorMessage("   ")).toBeUndefined();
    expect(formErrorMessage({ message: "Invalid email" })).toBe("Invalid email");
    expect(formErrorMessage({ message: " " })).toBeUndefined();
    expect(formErrorMessage(null)).toBeUndefined();
  });
});

describe("firstFieldError", () => {
  test("returns the first usable error message", () => {
    expect(firstFieldError([undefined, "", { message: "Slug already exists" }, "Second"])).toBe(
      "Slug already exists",
    );
    expect(firstFieldError([])).toBeUndefined();
  });
});

describe("visibleFieldError", () => {
  test("hides validation errors until touched or submitted", () => {
    expect(
      visibleFieldError({ isTouched: false, errors: ["Required"], errorMap: {} }, 0),
    ).toBeUndefined();
    expect(visibleFieldError({ isTouched: true, errors: ["Required"], errorMap: {} }, 0)).toBe(
      "Required",
    );
    expect(visibleFieldError({ isTouched: false, errors: ["Required"], errorMap: {} }, 1)).toBe(
      "Required",
    );
  });

  test("shows server/submit errors immediately even if field was untouched", () => {
    expect(
      visibleFieldError(
        { isTouched: false, errors: ["Already taken"], errorMap: { onSubmit: "Already taken" } },
        0,
      ),
    ).toBe("Already taken");
  });
});
