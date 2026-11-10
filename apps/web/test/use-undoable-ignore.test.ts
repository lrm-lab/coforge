import { afterEach, beforeEach, expect, jest, test } from "bun:test";

import {
  createUndoableIgnore,
  IGNORE_UNDO_MS,
} from "#src/features/conversations/use-undoable-ignore";

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

function setup(send = jest.fn(() => Promise.resolve())) {
  const changes: boolean[] = [];
  const ignore = createUndoableIgnore({ send, onChange: (ignored) => changes.push(ignored) });
  return { send, changes, ignore };
}

test("sends once, after the undo window", () => {
  const { send, changes, ignore } = setup();
  ignore.ignore();
  ignore.ignore();
  jest.advanceTimersByTime(IGNORE_UNDO_MS - 1);
  expect(send).not.toHaveBeenCalled();
  jest.advanceTimersByTime(1);
  expect(send).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledWith({ keepalive: false });
  jest.advanceTimersByTime(IGNORE_UNDO_MS * 2);
  expect(send).toHaveBeenCalledTimes(1);
  expect(changes).toEqual([true]);
});

test("undo prevents the send, and leaving after it sends nothing", () => {
  const { send, changes, ignore } = setup();
  ignore.ignore();
  jest.advanceTimersByTime(2_000);
  ignore.undo();
  ignore.leave();
  jest.advanceTimersByTime(IGNORE_UNDO_MS * 2);
  expect(send).not.toHaveBeenCalled();
  expect(changes).toEqual([true, false]);
});

test("leaving while counting sends at once with keepalive, and only once", () => {
  const { send, ignore } = setup();
  ignore.ignore();
  ignore.leave();
  ignore.leave();
  expect(send).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledWith({ keepalive: true });
  jest.advanceTimersByTime(IGNORE_UNDO_MS * 2);
  expect(send).toHaveBeenCalledTimes(1);
});

test("a failed keepalive send does nothing more", async () => {
  const send = jest.fn(() => Promise.reject(new Error("offline")));
  const { changes, ignore } = setup(send);
  ignore.ignore();
  ignore.leave();
  await Promise.resolve();
  jest.advanceTimersByTime(IGNORE_UNDO_MS * 2);
  expect(send).toHaveBeenCalledTimes(1);
  expect(changes).toEqual([true]);
});

test("leaving with nothing ignored sends nothing", () => {
  const { send, ignore } = setup();
  ignore.leave();
  expect(send).not.toHaveBeenCalled();
});

test("a failed timed send puts the card back and can be ignored again", async () => {
  const send = jest.fn(() => Promise.reject(new Error("nope")));
  const { changes, ignore } = setup(send);
  ignore.ignore();
  jest.advanceTimersByTime(IGNORE_UNDO_MS);
  await Promise.resolve();
  await Promise.resolve();
  expect(changes).toEqual([true, false]);
  ignore.ignore();
  expect(changes).toEqual([true, false, true]);
});
