import { describe, expect, test } from "bun:test";

import { ownMessageReadState } from "#src/features/conversations/conversation-pane-layout";

describe("own message read state", () => {
  test("an own message reads as read once another member read through it, sent before", () => {
    expect(ownMessageReadState(true, 4, 5)).toBe("read");
    expect(ownMessageReadState(true, 5, 5)).toBe("read");
    expect(ownMessageReadState(true, 6, 5)).toBe("sent");
    expect(ownMessageReadState(true, 1, 0)).toBe("sent");
  });

  test("someone else's message and a thread reply carry no ticks", () => {
    expect(ownMessageReadState(false, 1, 9)).toBeUndefined();
    expect(ownMessageReadState(true, 1, undefined)).toBeUndefined();
  });
});
