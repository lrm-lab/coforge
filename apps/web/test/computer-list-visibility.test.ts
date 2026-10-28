import { expect, test } from "bun:test";

import {
  defaultCloudComputerHiddenFromViewer,
  listedWorkspaceComputerWhere,
} from "#src/server/computers/computer-list-visibility.server";

test("another member's default cloud computer is hidden from the viewer", () => {
  expect(
    defaultCloudComputerHiddenFromViewer("viewer", {
      kind: "cloud",
      cloudSlot: "default",
      ownerId: "other",
    }),
  ).toBe(true);
});

test("the viewer's own default cloud computer stays listed", () => {
  expect(
    defaultCloudComputerHiddenFromViewer("viewer", {
      kind: "cloud",
      cloudSlot: "default",
      ownerId: "viewer",
    }),
  ).toBe(false);
});

test("another member's extra cloud computer stays listed", () => {
  expect(
    defaultCloudComputerHiddenFromViewer("viewer", {
      kind: "cloud",
      cloudSlot: "extra",
      ownerId: "other",
    }),
  ).toBe(false);
});

test("a local computer stays listed regardless of owner", () => {
  expect(
    defaultCloudComputerHiddenFromViewer("viewer", {
      kind: "local",
      cloudSlot: null,
      ownerId: "other",
    }),
  ).toBe(false);
});

test("the list query keeps own defaults, extras, and locals, and drops others' defaults", () => {
  expect(listedWorkspaceComputerWhere("viewer")).toEqual({
    deletedAt: null,
    OR: [{ ownerId: "viewer" }, { kind: "local" }, { kind: "cloud", cloudSlot: "extra" }],
  });
});
