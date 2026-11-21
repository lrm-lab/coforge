import { describe, expect, test } from "bun:test";

import {
  buildDisplayReportText,
  parseBrowserSummary,
} from "#src/features/artifacts/artifact-display-report";

describe("parseBrowserSummary", () => {
  test("parses Chrome on macOS", () => {
    expect(
      parseBrowserSummary(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
      ),
    ).toBe("Chrome 134, macOS");
  });

  test("parses Edge before Chrome", () => {
    expect(
      parseBrowserSummary(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36 Edg/134.0.0.0",
      ),
    ).toBe("Edge 134, Windows");
  });

  test("parses Safari on iOS", () => {
    expect(
      parseBrowserSummary(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Mobile/15E148 Safari/604.1",
      ),
    ).toBe("Safari 18.3, iOS");
  });

  test("parses Firefox on Linux", () => {
    expect(
      parseBrowserSummary("Mozilla/5.0 (X11; Linux x86_64; rv:135.0) Gecko/20100101 Firefox/135.0"),
    ).toBe("Firefox 135, Linux");
  });

  test("falls back to Unknown when blank", () => {
    expect(parseBrowserSummary("")).toBe("Unknown");
  });
});

describe("buildDisplayReportText", () => {
  test("formats structured viewer diagnostics with dimensions and pixel ratio", () => {
    expect(
      buildDisplayReportText({
        version: 2,
        width: 1447.4,
        height: 800.6,
        pixelRatio: 2,
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36",
      }),
    ).toBe(
      [
        "Display report from CoForge's viewer:",
        "Version: v2",
        "Page area: 1447x801 CSS px, Pixel ratio: 2x",
        "Browser: Chrome 156, macOS",
      ].join("\n"),
    );
  });

  test("omits page area when width or height is unavailable", () => {
    expect(
      buildDisplayReportText({
        version: 3,
        width: null,
        height: null,
        pixelRatio: 1.5,
        userAgent: "Mozilla/5.0 (X11; Linux x86_64; rv:135.0) Gecko/20100101 Firefox/135.0",
      }),
    ).toBe(
      [
        "Display report from CoForge's viewer:",
        "Version: v3",
        "Pixel ratio: 1.5x",
        "Browser: Firefox 135, Linux",
      ].join("\n"),
    );
  });
});
