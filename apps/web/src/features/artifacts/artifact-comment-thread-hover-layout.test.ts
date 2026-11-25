import { describe, expect, test } from "bun:test";
import { commentHeaderReservedEndClass } from "./artifact-comment-thread";

describe("commentHeaderReservedEndClass", () => {
  test("reserves width by toolbar button count without hover-only padding", () => {
    expect(commentHeaderReservedEndClass(0)).toBe("");
    expect(commentHeaderReservedEndClass(1)).toBe("pe-8");
    expect(commentHeaderReservedEndClass(2)).toBe("pe-15");
    expect(commentHeaderReservedEndClass(3)).toBe("pe-22");
    expect(commentHeaderReservedEndClass(4)).toBe("pe-29");
  });
});
