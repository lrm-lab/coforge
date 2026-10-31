import { expect, test } from "bun:test";

import { RowListeners, type ChangingRows } from "#src/features/conversations/sidebar-row-listeners";

/**
 * Task #361: every new message rewrites one sidebar row's last message, and the list re-rendered for
 * it. Each row now hears of its own row alone.
 */
function collection() {
  const callbacks = new Set<(changes: ReadonlyArray<{ key: string | number }>) => void>();
  const rows: ChangingRows = {
    subscribeChanges(callback) {
      callbacks.add(callback);
      return { unsubscribe: () => callbacks.delete(callback) };
    },
  };
  const change = (...keys: string[]) => {
    for (const callback of callbacks) callback(keys.map((key) => ({ key })));
  };
  return { rows, change, listening: () => callbacks.size };
}

function readers(listeners: RowListeners, ...keys: string[]) {
  const heard: string[] = [];
  const stops = keys.map((key) => listeners.subscribe(key, () => heard.push(key)));
  return { heard, stop: () => stops.forEach((stop) => stop()) };
}

test("a row that changes tells its own readers, and no one else", () => {
  const { rows, change } = collection();
  const listeners = new RowListeners(rows);
  const { heard } = readers(listeners, "general", "random", "dm");
  change("general");
  expect(heard).toEqual(["general"]);
  heard.length = 0;
  change("random", "dm");
  expect(heard).toEqual(["random", "dm"]);
});

test("the collection is listened to once, and only while a row is read", () => {
  const { rows, change, listening } = collection();
  const listeners = new RowListeners(rows);
  expect(listening()).toBe(0);
  const first = readers(listeners, "general", "random");
  const second = readers(listeners, "general");
  expect(listening()).toBe(1);
  first.stop();
  change("general", "random");
  expect(first.heard).toEqual([]);
  expect(second.heard).toEqual(["general"]);
  second.stop();
  expect(listening()).toBe(0);
});

test("a row read again after its last reader left is heard again", () => {
  const { rows, change } = collection();
  const listeners = new RowListeners(rows);
  readers(listeners, "general").stop();
  const again = readers(listeners, "general");
  change("general");
  expect(again.heard).toEqual(["general"]);
});
