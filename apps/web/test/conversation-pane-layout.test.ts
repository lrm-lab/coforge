import { describe, expect, test } from "bun:test";

import { ownMessageReadState } from "#src/features/conversations/conversation-pane-layout";

describe("own message read state", () => {
  const ticks = { othersReadThroughSequence: 5, latestOwnSequence: 6 };

  test("an own message reads as read once another member read through it, sent before", () => {
    expect(ownMessageReadState(true, 4, ticks)?.read).toBe(true);
    expect(ownMessageReadState(true, 5, ticks)?.read).toBe(true);
    expect(ownMessageReadState(true, 6, ticks)?.read).toBe(false);
  });

  test("only the newest own message shows its ticks without a hover", () => {
    expect(ownMessageReadState(true, 6, ticks)).toEqual({ read: false, latest: true });
    expect(ownMessageReadState(true, 4, ticks)).toEqual({ read: true, latest: false });
  });

  test("someone else's message and a thread reply carry no ticks", () => {
    expect(ownMessageReadState(false, 1, ticks)).toBeUndefined();
    expect(ownMessageReadState(true, 1, undefined)).toBeUndefined();
  });
});

test("an own message keeps the same read state object while its ticks do not change", () => {
  const ticks = { othersReadThroughSequence: 5, latestOwnSequence: 7 };
  expect(ownMessageReadState(true, 4, ticks)).toBe(ownMessageReadState(true, 3, ticks));
  expect(ownMessageReadState(true, 7, ticks)).toEqual({ read: false, latest: true });
});
