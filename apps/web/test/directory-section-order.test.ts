import { describe, expect, test } from "bun:test";
import {
  directorySectionOrder,
  storedSectionOrder,
} from "#src/features/conversations/directory-section-order";
import { sortSectionRows } from "#src/features/conversations/chat-section-sort";

describe("directorySectionOrder", () => {
  test("with nothing saved: Pinned, the custom sections, Channels, Direct messages", () => {
    expect(directorySectionOrder([], ["a", "b"])).toEqual([
      "pinned",
      "custom:a",
      "custom:b",
      "channels",
      "agents",
    ]);
  });

  test("a saved order wins, built-in sections included", () => {
    expect(directorySectionOrder(["agents", "b", "channels", "pinned", "a"], ["a", "b"])).toEqual([
      "agents",
      "custom:b",
      "channels",
      "pinned",
      "custom:a",
    ]);
  });

  test("a section the saved order does not name keeps its place after its default neighbour", () => {
    // "c" was created after the order was saved; it follows "b", as it does by default.
    expect(directorySectionOrder(["channels", "pinned", "b", "agents"], ["b", "c"])).toEqual([
      "channels",
      "pinned",
      "custom:b",
      "custom:c",
      "agents",
    ]);
    // A saved order that names only custom sections leaves the built-in ones where they were.
    expect(directorySectionOrder(["b", "a"], ["a", "b"])).toEqual([
      "pinned",
      "custom:b",
      "custom:a",
      "channels",
      "agents",
    ]);
  });

  test("entries for deleted sections and repeats are dropped", () => {
    expect(directorySectionOrder(["gone", "agents", "agents", "a"], ["a"])).toEqual([
      "pinned",
      "agents",
      "custom:a",
      "channels",
    ]);
  });

  test("stores custom sections by id", () => {
    expect(storedSectionOrder(["channels", "custom:a", "pinned", "agents"])).toEqual([
      "channels",
      "a",
      "pinned",
      "agents",
    ]);
  });
});

describe("sortSectionRows", () => {
  const rows = [
    { key: "k1", name: "zeta", lastMessageAt: "2026-10-12T10:00:00Z" },
    { key: "k2", name: "Alpha", lastMessageAt: null },
    { key: "k3", name: "beta", lastMessageAt: "2026-10-13T10:00:00Z" },
    { key: "k4", name: "item 10", lastMessageAt: "2026-10-12T10:00:00Z" },
    { key: "k5", name: "item 9", lastMessageAt: null },
    { key: "k6", name: "item 8", lastMessageAt: "not a time" },
  ];

  test("Manual keeps the drag order", () => {
    expect(sortSectionRows(rows, "manual")).toEqual(["k1", "k2", "k3", "k4", "k5", "k6"]);
  });

  test("Recent: latest first; ties, and rows without a (valid) time last, keep the drag order", () => {
    expect(sortSectionRows(rows, "recent")).toEqual(["k3", "k1", "k4", "k2", "k5", "k6"]);
  });

  test("A-Z ignores case and reads numbers as numbers", () => {
    expect(sortSectionRows(rows, "alpha", "en")).toEqual(["k2", "k3", "k6", "k5", "k4", "k1"]);
  });
});
