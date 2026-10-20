import { describe, expect, test } from "bun:test";

import { appMonogram, filterApps } from "#src/features/apps/app-list";

describe("an app's monogram", () => {
  test("is the first letters of its first two words, in capitals", () => {
    expect(appMonogram("Acme Notes")).toBe("AN");
    expect(appMonogram("  acme   cloud drive ")).toBe("AC");
  });

  test("is the first two characters of a one-word name", () => {
    expect(appMonogram("notion")).toBe("NO");
    expect(appMonogram("笔记应用")).toBe("笔记");
    expect(appMonogram("X")).toBe("X");
  });

  test("never splits a character made of two code units", () => {
    expect(appMonogram("😀😃 apps")).toBe("😀A");
    expect(appMonogram("😀😃")).toBe("😀😃");
  });
});

describe("the apps a view shows", () => {
  const apps = [
    { key: "acme-notes", name: "Acme Notes", description: "Team notes", category: "productivity" },
    {
      key: "deploy-bot",
      name: "Deployer",
      description: "Ships builds",
      category: "developer-tools",
    },
    {
      key: "chat-bridge",
      name: "Bridge",
      description: "Mirrors NOTES to chat",
      category: "communication",
    },
  ] as const;
  const keys = (shown: readonly { key: string }[]) => shown.map((app) => app.key);

  test("are all of them, in order, with no search and every category", () => {
    expect(keys(filterApps(apps, { query: "", category: "all" }))).toEqual([
      "acme-notes",
      "deploy-bot",
      "chat-bridge",
    ]);
  });

  test("match the search in the name, description or client ID, ignoring case", () => {
    expect(keys(filterApps(apps, { query: "notes", category: "all" }))).toEqual([
      "acme-notes",
      "chat-bridge",
    ]);
    expect(keys(filterApps(apps, { query: "DEPLOY-B", category: "all" }))).toEqual(["deploy-bot"]);
    expect(keys(filterApps(apps, { query: "  ships ", category: "all" }))).toEqual(["deploy-bot"]);
  });

  test("are only the chosen category's, together with the search", () => {
    expect(keys(filterApps(apps, { query: "", category: "communication" }))).toEqual([
      "chat-bridge",
    ]);
    expect(keys(filterApps(apps, { query: "notes", category: "productivity" }))).toEqual([
      "acme-notes",
    ]);
    expect(filterApps(apps, { query: "", category: "other" })).toEqual([]);
  });
});
