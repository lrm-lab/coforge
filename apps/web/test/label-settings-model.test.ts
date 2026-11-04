import { expect, test } from "bun:test";

import {
  LABEL_NAME_MAX_LENGTH,
  labelSections,
  nameTaken,
  type SettingsLabel,
} from "#src/features/tasks/label-settings-model";
import { labelUpdateInput } from "#src/server/tasks/label-update-input.server";
import { LABEL_NAME_MAX } from "#src/server/tasks/labels.server";

/** Settings → Labels (task #508): what the page lists, and a name already taken. */

const label = (name: string, parts: Partial<SettingsLabel> = {}): SettingsLabel => ({
  id: name,
  name,
  color: "gray",
  description: null,
  archivedAt: null,
  group: null,
  taskCount: 0,
  openCount: 0,
  lastUsedAt: null,
  ...parts,
});
const group = (name: string) => ({ id: name, name });
const names = (list: readonly SettingsLabel[]) => list.map((each) => each.name);

test("live labels come by group, ungrouped first, each list by name ignoring case", () => {
  const { live, archived } = labelSections(
    [
      label("bug", { group: group("Type") }),
      label("Docs"),
      label("feature", { group: group("Type") }),
      label("urgent", { group: group("Priority") }),
      label("api"),
    ],
    "",
  );
  expect(live.map((section) => [section.group, names(section.labels)])).toEqual([
    [null, ["api", "Docs"]],
    ["Priority", ["urgent"]],
    ["Type", ["bug", "feature"]],
  ]);
  expect(archived).toEqual([]);
});

test("archived labels are kept apart, whatever their group", () => {
  const { live, archived } = labelSections(
    [
      label("old", { archivedAt: "2026-11-01T00:00:00.000Z", group: group("Type") }),
      label("Older", { archivedAt: new Date("2026-10-01") }),
      label("kept"),
    ],
    "",
  );
  expect(live.map((section) => names(section.labels))).toEqual([["kept"]]);
  expect(names(archived)).toEqual(["old", "Older"]);
});

test("the search matches a name or what the label is for, ignoring case", () => {
  const all = [
    label("Bug", { description: "Something broken" }),
    label("Design"),
    label("Gone", { archivedAt: new Date(), description: "a broken idea" }),
  ];
  const { live, archived } = labelSections(all, "  BROKEN ");
  expect(live.flatMap((section) => names(section.labels))).toEqual(["Bug"]);
  expect(names(archived)).toEqual(["Gone"]);
  // A search that matches nothing leaves no empty sections.
  expect(labelSections(all, "zzz")).toEqual({ live: [], archived: [] });
});

test("the page's name limit is the server's", () => {
  expect(LABEL_NAME_MAX_LENGTH).toBe(LABEL_NAME_MAX);
});

test("updateTaskLabel takes a description of at most 200 characters, or null to clear it", () => {
  const id = crypto.randomUUID();
  expect(labelUpdateInput.safeParse({ id, description: "x".repeat(200) }).success).toBe(true);
  expect(labelUpdateInput.safeParse({ id, description: "x".repeat(201) }).success).toBe(false);
  expect(labelUpdateInput.safeParse({ id, description: null }).success).toBe(true);
  // Nothing it does not know: the server's other inputs (group) are not the page's to send.
  expect(labelUpdateInput.safeParse({ id, group: "Type" }).success).toBe(false);
});

test("a name is taken by another label in any case, never by the label itself", () => {
  const all = [label("Bug"), label("Design")];
  expect(nameTaken(all, " bug ")).toBe(true);
  expect(nameTaken(all, "BUG", "Bug")).toBe(false);
  expect(nameTaken(all, "Docs")).toBe(false);
});
