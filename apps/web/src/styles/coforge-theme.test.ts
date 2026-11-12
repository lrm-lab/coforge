import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";

/** Every CoForge token this file adds, and whether it carries a dark-mode value.
 *
 * The bug this guards against shipped twice: a token added with one value for both themes, used by
 * a component, and only looked at in light mode — the chat list's selected row rendered as a white
 * card under light-grey text, and the sidebar's opaque row fill as hard-edged blocks on the dark
 * gradient. A token is allowed to stay flat, but it has to say why here. */
const FLAT_ON_PURPOSE = new Map([
  ["--color-terminal", "a terminal block stays dark in both themes"],
  ["--color-terminal-fg", "a terminal block stays dark in both themes"],
  ["--color-avatar-1", "avatar placeholder tones carry their own contrast with white initials"],
  ["--color-avatar-2", "avatar placeholder tones carry their own contrast with white initials"],
  ["--color-avatar-3", "avatar placeholder tones carry their own contrast with white initials"],
  ["--color-avatar-4", "avatar placeholder tones carry their own contrast with white initials"],
  ["--color-avatar-5", "avatar placeholder tones carry their own contrast with white initials"],
  ["--color-avatar-6", "avatar placeholder tones carry their own contrast with white initials"],
  ["--color-avatar-outline", "a sticker's edge matches the mascot artwork's, white in both themes"],
  ["--color-nav-fg-current", "it points at --color-sidebar-fg, which carries its own dark value"],
]);

// Comments are stripped first: the file's own prose quotes `.dark-mode { ... }` when it explains
// the mechanism, which a plain search would find before the real block.
const css = readFileSync(new URL("./coforge-theme.css", import.meta.url), "utf8").replaceAll(
  /\/\*[\s\S]*?\*\//g,
  "",
);

function block(startPattern: RegExp): string {
  const start = css.search(startPattern);
  expect(start).toBeGreaterThanOrEqual(0);
  const from = css.indexOf("{", start);
  let depth = 0;
  for (let i = from; i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(from, i);
    }
  }
  throw new Error("unbalanced braces in coforge-theme.css");
}

function declaredTokens(source: string): string[] {
  return [...source.matchAll(/^\s*(--color-[\w-]+):/gm)].map((match) => match[1]!);
}

test("every CoForge colour token either has a dark-mode value or says why it is flat", () => {
  // The brand ramp is deliberately untouched between themes (Untitled re-points semantic tokens at
  // a different step instead; see the file header), so it is not part of this rule.
  const added = declaredTokens(block(/@theme\s*\{/)).filter(
    (token) => !token.startsWith("--color-brand-"),
  );
  const dark = new Set(declaredTokens(block(/\.dark-mode\s*\{/)));

  expect(added.length).toBeGreaterThan(0);
  const unexplained = added.filter((token) => !dark.has(token) && !FLAT_ON_PURPOSE.has(token));
  expect(unexplained).toEqual([]);
});

test("the sidebar's rows do not paint a resting fill over its gradient", () => {
  const dark = block(/\.dark-mode\s*\{/);
  // An opaque fill reads darker than the gradient at the top of the column and lighter at the
  // bottom, which is what turned the nav into eight blocks, in either theme.
  expect(css).not.toMatch(/--color-sidebar-item:/);
  // The rail and the expanded rows share one highlight, so the current item cannot look like two
  // different things depending on which sidebar is showing.
  expect(dark).toMatch(/--color-sidebar-item-active:\s*var\(--color-sidebar-accent\);/);
  expect(dark).toMatch(/--color-chat-selected-bg:\s*var\(--color-sidebar-accent\);/);
});

/** WCAG relative luminance of a `#rrggbb` colour. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

test("the faintest light-mode text greys still read at 4.5:1 on every light surface (task #3)", () => {
  const light = block(/@theme\s*\{/);
  const value = (token: string): string => {
    const declared = light.match(new RegExp(`${token}:\\s*([^;]+);`))?.[1]?.trim();
    if (!declared) throw new Error(`${token} is not declared in @theme`);
    const ref = declared.match(/^var\((--color-[\w-]+)\)$/)?.[1];
    return ref ? value(ref) : declared;
  };
  // Untitled's own light surfaces (Tailwind's neutral ramp, which theme.css points them at) and
  // the CoForge fills text sits on: rows, the selected chat, the sidebar and its current item.
  const surfaces = {
    "bg-primary": "#ffffff",
    "bg-secondary (neutral-50)": "#fafafa",
    "neutral-100": "#f5f5f5",
    ...Object.fromEntries(
      [
        "--color-message-hover",
        "--color-chat-selected-bg",
        "--color-sidebar",
        "--color-sidebar-accent",
        "--color-sidebar-item-active",
        "--color-nav-bg-current",
      ].map((token) => [token, value(token)]),
    ),
  };
  const below = ["--color-text-quaternary", "--color-thread-reply-count"].flatMap((text) =>
    Object.entries(surfaces)
      .filter(([, surface]) => contrast(value(text), surface) < 4.5)
      .map(([name, surface]) => `${text} on ${name}: ${contrast(value(text), surface).toFixed(2)}`),
  );
  expect(below).toEqual([]);
});
