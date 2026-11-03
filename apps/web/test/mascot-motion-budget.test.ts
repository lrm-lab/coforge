import { expect, test } from "bun:test";
import { MASCOT_MOTION_LIMIT, mascotsInMotion } from "#src/features/agents/mascot-motion-budget";

type Seen = Parameters<typeof mascotsInMotion>[0][number];

const seen = (id: string, overrides: Partial<Seen> = {}): Seen => ({
  id,
  onScreen: true,
  covered: false,
  hovered: false,
  settling: false,
  atWork: true,
  uncapped: false,
  ...overrides,
});

test("Frank's limit: at most three mascots move at once", () => {
  expect(MASCOT_MOTION_LIMIT).toBe(3);
  const moving = mascotsInMotion(["a", "b", "c", "d", "e"].map((id) => seen(id)));
  expect(moving.play.size).toBe(3);
  expect(moving.pause.size).toBe(2);
});

test("the last on the page come first: overlays and the open pane before the sidebar", () => {
  // Page order: the sidebar renders before the conversation, and popovers and the hover card
  // are portaled to the end of the page.
  const moving = mascotsInMotion([
    seen("sidebar-1"),
    seen("sidebar-2"),
    seen("pane"),
    seen("hover-card"),
  ]);
  expect([...moving.play]).toEqual(["hover-card", "pane", "sidebar-2"]);
  expect([...moving.pause]).toEqual(["sidebar-1"]);
});

test("Agents working or thinking come before idle, offline or failing ones", () => {
  const moving = mascotsInMotion([
    seen("working"),
    seen("idle-1", { atWork: false }),
    seen("idle-2", { atWork: false }),
    seen("idle-3", { atWork: false }),
  ]);
  expect(moving.play.has("working")).toBe(true);
  expect([...moving.pause]).toEqual(["idle-1"]);
});

test("a mascot covered by another face or a dialog stays still and takes no place", () => {
  const moving = mascotsInMotion([
    seen("a"),
    seen("b"),
    seen("c"),
    seen("under", { covered: true, hovered: true }),
  ]);
  expect([...moving.play].sort()).toEqual(["a", "b", "c"]);
  expect([...moving.pause]).toEqual(["under"]);
});

test("the mascot under the pointer, and one acting out a new activity, move whatever their place", () => {
  const moving = mascotsInMotion([
    seen("hovered", { hovered: true, atWork: false }),
    seen("changed", { settling: true, atWork: false }),
    seen("a"),
    seen("b"),
  ]);
  expect([...moving.play]).toEqual(["hovered", "changed", "b"]);
  expect([...moving.pause]).toEqual(["a"]);
});

test("the mascot under the pointer beats rows it just left, which are still settling", () => {
  // The pointer swept up a list: the rows below it left the pointer a moment ago.
  const moving = mascotsInMotion([
    seen("hovered", { hovered: true, atWork: false }),
    seen("left-1", { settling: true }),
    seen("left-2", { settling: true }),
    seen("left-3", { settling: true }),
  ]);
  expect(moving.play.has("hovered")).toBe(true);
  expect(moving.pause.size).toBe(1);
});

test("a mascot off screen is left to the runtime, which already stops drawing it", () => {
  const moving = mascotsInMotion([seen("away", { onScreen: false }), seen("a")]);
  expect([...moving.play]).toEqual(["a"]);
  expect([...moving.pause]).toEqual([]);
});

test("the mascot picker's choices are outside the limit", () => {
  const moving = mascotsInMotion([
    ...["p1", "p2", "p3", "p4"].map((id) => seen(id, { uncapped: true })),
    seen("a"),
  ]);
  expect([...moving.play].sort()).toEqual(["a", "p1", "p2", "p3", "p4"]);
});
