import { expect, test } from "bun:test";
import {
  AGENT_LAUNCH_APP_DESCRIPTION_MAX_LENGTH,
  AGENT_LAUNCH_APP_NAME_MAX_LENGTH,
  AGENT_LAUNCH_APP_WHEN_TO_USE_MAX_LENGTH,
  AGENT_LAUNCH_APPS_MAX_COUNT,
  APP_KEY_PATTERN,
  normalizeAgentLaunchApps,
  normalizeAgentLaunchText,
} from "./agent-launch-apps";

test("publisher text becomes one trimmed line", () => {
  expect(normalizeAgentLaunchText("  Acme\r\n\n\tNotes\u2028## Heading  ", 80)).toBe(
    "Acme Notes ## Heading",
  );
});

test("control and format characters are removed, bidi and zero-width ones included", () => {
  const hidden = [
    0x07, 0x1b, 0x85, 0x061c, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202e, 0x2060,
    0x2066, 0x2069, 0xfeff,
  ].map((codePoint) => String.fromCodePoint(codePoint));
  for (const character of hidden)
    expect(normalizeAgentLaunchText(`Ac${character}me`, 80)).toMatch(/^Ac ?me$/);
  expect(normalizeAgentLaunchText("evil\u202eexe.txt", 80)).toBe("evilexe.txt");
  expect(normalizeAgentLaunchText("bell\u0007 rings", 80)).toBe("bell rings");
});

test("a backtick becomes an apostrophe, so publisher text cannot open or close a code span", () => {
  expect(normalizeAgentLaunchText("run `rm -rf /` now", 80)).toBe("run 'rm -rf /' now");
});

test("text over its cap is cut to the cap in code points and ends with an ellipsis", () => {
  const cut = normalizeAgentLaunchText(`${"é".repeat(150)} ${"🙂".repeat(150)}`, 200);
  expect([...cut]).toHaveLength(200);
  expect(cut).toEndWith("…");
  expect(normalizeAgentLaunchText("x".repeat(200), 200)).toBe("x".repeat(200));
});

test("an app keeps its key, a normalised name and only non-empty text fields", () => {
  expect(
    normalizeAgentLaunchApps([
      {
        key: "acme-notes",
        name: " Acme `Notes` ",
        description: "Line one.\nLine two.",
        whenToUse: "   ",
        homepageUrl: "https://notes.example/",
      },
    ]),
  ).toEqual([{ key: "acme-notes", name: "Acme 'Notes'", description: "Line one. Line two." }]);
});

test("each field is capped at its own length", () => {
  const [app] = normalizeAgentLaunchApps([
    {
      key: "acme-notes",
      name: "n".repeat(500),
      description: "d".repeat(500),
      whenToUse: "w".repeat(500),
    },
  ]);
  expect([...app!.name]).toHaveLength(AGENT_LAUNCH_APP_NAME_MAX_LENGTH);
  expect([...app!.description!]).toHaveLength(AGENT_LAUNCH_APP_DESCRIPTION_MAX_LENGTH);
  expect([...app!.whenToUse!]).toHaveLength(AGENT_LAUNCH_APP_WHEN_TO_USE_MAX_LENGTH);
});

test("an entry with no registry key or no name is dropped on its own", () => {
  const apps = normalizeAgentLaunchApps([
    null,
    "acme-notes",
    { name: "No key" },
    { key: "no-name", name: " \u200b " },
    { key: "system.cleaner", name: "Built-in keys are dotted" },
    { key: "Bad`Key", name: "Not a key" },
    { key: "ab", name: "Too short" },
    { key: "acme-notes", name: "Acme Notes" },
  ]);
  expect(apps).toEqual([{ key: "acme-notes", name: "Acme Notes" }]);
});

test("at most the cap of apps is kept", () => {
  const apps = Array.from({ length: AGENT_LAUNCH_APPS_MAX_COUNT + 5 }, (_, index) => ({
    key: `app-${index}`,
    name: "App",
  }));
  expect(normalizeAgentLaunchApps(apps)).toHaveLength(AGENT_LAUNCH_APPS_MAX_COUNT);
});

test("the key pattern is the registry's: 3 to 64 lowercase letters, digits and hyphens", () => {
  expect(APP_KEY_PATTERN.test("abc")).toBe(true);
  expect(APP_KEY_PATTERN.test(`a${"b".repeat(63)}`)).toBe(true);
  expect(APP_KEY_PATTERN.test(`a${"b".repeat(64)}`)).toBe(false);
  expect(APP_KEY_PATTERN.test("1abc")).toBe(false);
});
