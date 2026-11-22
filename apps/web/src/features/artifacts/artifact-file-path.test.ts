import { describe, expect, test } from "bun:test";

import { middleTruncatePath } from "./artifact-file-path";

describe("middleTruncatePath", () => {
  test("returns short paths unchanged", () => {
    expect(middleTruncatePath("index.html")).toBe("index.html");
    expect(middleTruncatePath("src/limiter.ts")).toBe("src/limiter.ts");
  });

  test("preserves leading directory and full filename with version suffix for deep paths", () => {
    const v11 =
      "packages/platform/services/ultra-long-unbroken-directory-name/Q3-Board-Deck-FINAL-v11.json";
    const v12 =
      "packages/platform/services/ultra-long-unbroken-directory-name/Q3-Board-Deck-FINAL-v12.json";

    const short11 = middleTruncatePath(v11, 42);
    const short12 = middleTruncatePath(v12, 42);

    expect(short11).toBe("packages/…/Q3-Board-Deck-FINAL-v11.json");
    expect(short12).toBe("packages/…/Q3-Board-Deck-FINAL-v12.json");
    expect(short11).not.toBe(short12);
    expect(Array.from(short11).length).toBeLessThanOrEqual(42);
  });

  test("handles long two-segment paths and long single filenames without losing suffix", () => {
    const twoSeg = "ultra-long-top-level-directory-name-exceeding-limit/report-v2.json";
    const truncatedTwo = middleTruncatePath(twoSeg, 36);
    expect(truncatedTwo.endsWith("/report-v2.json")).toBe(true);
    expect(truncatedTwo.includes("…")).toBe(true);
    expect(Array.from(truncatedTwo).length).toBeLessThanOrEqual(36);

    const single = "quarterly-revenue-projection-spreadsheet-final-v12.csv";
    const truncatedSingle = middleTruncatePath(single, 30);
    expect(truncatedSingle.endsWith("final-v12.csv")).toBe(true);
    expect(truncatedSingle.includes("…")).toBe(true);
    expect(Array.from(truncatedSingle).length).toBeLessThanOrEqual(30);
  });

  test("preserves surrogate pairs and CJK characters safely", () => {
    const unicode = "报告目录/子目录很长很长很长/季度汇总_🚀🔥_最终版v2.md";
    const truncated = middleTruncatePath(unicode, 24);
    expect(truncated.endsWith("最终版v2.md")).toBe(true);
    expect(Array.from(truncated).length).toBeLessThanOrEqual(24);
  });

  test("distinguishes deep paths with ultra-long basenames differing in mid-name version tokens", () => {
    const paths = Array.from({ length: 26 }, (_, index) => {
      const version = String(index + 1).padStart(2, "0");
      return `packages/platform-security/compliance/2026/q4/contracts/legal_and_compliance_enterprise_master_agreement_v${version}_approved_by_legal.md`;
    });

    for (const limit of [42, 28]) {
      const outputs = paths.map((item) => middleTruncatePath(item, limit));
      expect(new Set(outputs).size).toBe(26);
      outputs.forEach((output, index) => {
        const version = `v${String(index + 1).padStart(2, "0")}`;
        expect(output.includes(version)).toBe(true);
        expect(output.endsWith(".md")).toBe(true);
        expect(Array.from(output).length).toBeLessThanOrEqual(limit);
      });
    }
  });
});
