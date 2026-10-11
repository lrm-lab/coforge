import { describe, expect, test } from "bun:test";
import { thrownMessage } from "./thrown-message";

describe("thrownMessage", () => {
  test("reads the message of an Error, including a subclass and an empty message", () => {
    expect(thrownMessage(new Error("gone"))).toBe("gone");
    expect(thrownMessage(new TypeError("bad type"))).toBe("bad type");
    expect(thrownMessage(new Error(""))).toBe("");
  });

  test("stringifies anything else that was thrown", () => {
    expect(thrownMessage("plain text")).toBe("plain text");
    expect(thrownMessage(42)).toBe("42");
    expect(thrownMessage(undefined)).toBe("undefined");
    expect(thrownMessage(null)).toBe("null");
    // An Error-shaped object that is not an Error is stringified, not read for `.message`.
    expect(thrownMessage({ message: "not an Error" })).toBe("[object Object]");
  });
});
