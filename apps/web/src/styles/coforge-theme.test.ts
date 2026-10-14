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
  ["--color-avatar-border-start", "the avatar frame gradient is the same in both themes"],
  ["--color-avatar-border-end", "the avatar frame gradient is the same in both themes"],
  ["--color-avatar-1", "avatar placeholder tones carry their own contrast with white initials"],
  ["--color-avatar-2", "avatar placeholder tones carry their own contrast with white initials"],
  ["--color-avatar-3", "avatar placeholder tones carry their own contrast with white initials"],
  ["--color-avatar-4", "avatar placeholder tones carry their own contrast with white initials"],
  ["--color-avatar-5", "avatar placeholder tones carry their own contrast with white initials"],
  ["--color-avatar-6", "avatar placeholder tones carry their own contrast with white initials"],
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

test("the sidebar's dark rows do not paint an opaque fill over its gradient", () => {
  const dark = block(/\.dark-mode\s*\{/);
  // An opaque fill reads darker than the gradient at the top of the column and lighter at the
  // bottom, which is what turned the nav into eight blocks.
  expect(dark).toMatch(/--color-sidebar-item:\s*transparent;/);
  // The rail and the expanded rows share one highlight, so the current item cannot look like two
  // different things depending on which sidebar is showing.
  expect(dark).toMatch(/--color-sidebar-item-active:\s*var\(--color-sidebar-accent\);/);
  expect(dark).toMatch(/--color-chat-selected-bg:\s*var\(--color-sidebar-accent\);/);
});
