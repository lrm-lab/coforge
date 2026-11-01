import { expect, test } from "bun:test";
import { openState } from "#src/features/conversations/conversation-open-state";

const window = (...sequences: number[]) =>
  sequences.map((sequence) => ({ id: `m${sequence}`, sequence }));
const first = (sequence: number) => ({ id: `m${sequence}`, sequence });

test("an open waits for its read, and a failed one leaves no divider", () => {
  expect(openState({ status: "pending" }, window(1, 2, 3))).toEqual({ waiting: true });
  expect(openState({ status: "error" }, window(1, 2, 3))).toEqual({ waiting: true });
});

test("nothing unread opens at once without a divider, whatever the window holds", () => {
  expect(openState({ status: "success", firstUnread: null }, window(1, 2))).toEqual({
    waiting: false,
  });
  expect(openState({ status: "success", firstUnread: null }, [])).toEqual({ waiting: false });
});

test("the divider goes on the read's first unread message once the window holds it", () => {
  expect(openState({ status: "success", firstUnread: first(2) }, window(1, 2, 3))).toEqual({
    waiting: false,
    boundary: first(2),
  });
});

test("a window held from earlier waits for the catch-up that brings the first unread", () => {
  const read = { status: "success", firstUnread: first(5) } as const;
  expect(openState(read, window(1, 2, 3))).toEqual({ waiting: true });
  expect(openState(read, [])).toEqual({ waiting: true });
  expect(openState(read, window(1, 2, 3, 4, 5, 6))).toEqual({
    waiting: false,
    boundary: first(5),
  });
});

test("a first unread older than the whole window is read around, as a jump is", () => {
  expect(openState({ status: "success", firstUnread: first(2) }, window(50, 51))).toEqual({
    waiting: true,
    readAround: "m2",
  });
});

test("a window around the first unread that does not show it opens at the latest", () => {
  expect(openState({ status: "success", firstUnread: first(3) }, window(1, 2, 4))).toEqual({
    waiting: false,
    boundary: first(3),
  });
});
