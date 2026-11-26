import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "bun:test";

import { DURATION_MS, EASE_CSS } from "#src/utils/motion-tokens";

const STYLES_DIR = fileURLToPath(new URL(".", import.meta.url));
const MAIN_CSS_PATH = fileURLToPath(new URL("../styles.css", import.meta.url));
const HOVER_MOTION_CSS_PATH = fileURLToPath(new URL("./hover-motion.css", import.meta.url));

const mainCss = [MAIN_CSS_PATH, HOVER_MOTION_CSS_PATH]
  .map((path) => readFileSync(path, "utf8"))
  .join("\n")
  .replaceAll(/\/\*[\s\S]*?\*\//g, "");

const REDUCED_MOTION_EXEMPT_STYLESHEETS = new Set([
  "theme.css",
  "typography.css",
  "scroll-fade.css",
]);

function readCssToken(css: string, name: string): string | undefined {
  const match = css.match(new RegExp(`${name}:\\s*([^;]+);`));
  return match?.[1]?.trim();
}

function parseMs(value: string | undefined): number {
  expect(value).toBeDefined();
  const match = value!.match(/^(\d+(?:\.\d+)?)ms$/);
  expect(match).not.toBeNull();
  return Number.parseFloat(match![1]!);
}

test("styles.css motion duration and easing tokens stay synchronized with motion-tokens.ts", () => {
  const expectedDurations: ReadonlyArray<readonly [string, number]> = [
    ["--duration-sm", DURATION_MS.sm],
    ["--duration-sm-out", DURATION_MS.smOut],
    ["--duration-md", DURATION_MS.md],
    ["--duration-md-out", DURATION_MS.mdOut],
    ["--duration-lg", DURATION_MS.lg],
    ["--duration-lg-out", DURATION_MS.lgOut],
    ["--duration-label-in", DURATION_MS.labelIn],
    ["--duration-label-out", DURATION_MS.labelOut],
    ["--duration-card-in", DURATION_MS.cardIn],
    ["--duration-card-out", DURATION_MS.cardOut],
    ["--duration-preview-in", DURATION_MS.previewIn],
    ["--duration-preview-out", DURATION_MS.previewOut],
  ];

  for (const [token, expectedMs] of expectedDurations) {
    expect(parseMs(readCssToken(mainCss, token))).toBe(expectedMs);
  }

  expect(readCssToken(mainCss, "--ease-out")).toBe(EASE_CSS.out);
  expect(readCssToken(mainCss, "--ease-out-strong")).toBe(EASE_CSS.outStrong);
  expect(readCssToken(mainCss, "--ease-in")).toBe(EASE_CSS.in);
  expect(readCssToken(mainCss, "--ease-in-out")).toBe(EASE_CSS.inOut);
  expect(readCssToken(mainCss, "--ease-overshoot")).toBe(EASE_CSS.overshoot);
});

test("every exit motion duration is faster than or equal to its matching enter duration", () => {
  expect(DURATION_MS.smOut).toBeLessThanOrEqual(DURATION_MS.sm);
  expect(DURATION_MS.mdOut).toBeLessThanOrEqual(DURATION_MS.md);
  expect(DURATION_MS.lgOut).toBeLessThanOrEqual(DURATION_MS.lg);
  expect(DURATION_MS.labelOut).toBeLessThanOrEqual(DURATION_MS.labelIn);
  expect(DURATION_MS.cardOut).toBeLessThanOrEqual(DURATION_MS.cardIn);
  expect(DURATION_MS.previewOut).toBeLessThanOrEqual(DURATION_MS.previewIn);
});

test("every custom animated stylesheet includes a prefers-reduced-motion rule", () => {
  const cssFiles = readdirSync(STYLES_DIR).filter((name) => name.endsWith(".css"));
  const missing: string[] = [];

  for (const file of cssFiles) {
    if (REDUCED_MOTION_EXEMPT_STYLESHEETS.has(file)) continue;
    const content = readFileSync(join(STYLES_DIR, file), "utf8");
    const hasTimeMotion = /@keyframes\b|transition\s*:/.test(content);
    if (hasTimeMotion && !content.includes("prefers-reduced-motion")) {
      missing.push(file);
    }
  }

  expect(mainCss).toContain("@media (prefers-reduced-motion: reduce)");
  expect(missing).toEqual([]);
});

test("custom stylesheets gate :hover rules inside @media (hover: hover)", () => {
  const targets = [
    { name: "styles.css", content: mainCss },
    ...readdirSync(STYLES_DIR)
      .filter((name) => name.endsWith(".css") && name !== "theme.css")
      .map((name) => ({
        name,
        content: readFileSync(join(STYLES_DIR, name), "utf8").replaceAll(/\/\*[\s\S]*?\*\//g, ""),
      })),
  ];

  const unguarded: string[] = [];
  for (const { name, content } of targets) {
    let depth = 0;
    let hoverMediaDepth: number | null = null;
    const lines = content.split("\n");
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!;
      if (/@media\s*\([^)]*hover\s*:\s*hover/.test(line)) {
        hoverMediaDepth = depth;
      }
      if (/:hover\b/.test(line) && hoverMediaDepth === null) {
        unguarded.push(`${name}:${index + 1}`);
      }
      for (const ch of line) {
        if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (hoverMediaDepth !== null && depth <= hoverMediaDepth) {
            hoverMediaDepth = null;
          }
        }
      }
    }
  }

  expect(unguarded).toEqual([]);
});
