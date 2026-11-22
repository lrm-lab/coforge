import { afterEach, describe, expect, test } from "bun:test";

import {
  readShowJoinedChannelsOnly,
  writeShowJoinedChannelsOnly,
} from "./show-joined-channels-only";

describe("show joined channels only preference", () => {
  const originalStorage = globalThis.localStorage;

  afterEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      value: originalStorage,
      configurable: true,
      writable: true,
    });
  });

  function installStorage(initial = new Map<string, string>()) {
    const store = new Map(initial);
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
      clear: () => {
        store.clear();
      },
      key: (index: number) => [...store.keys()][index] ?? null,
      get length() {
        return store.size;
      },
    } satisfies Storage;
    Object.defineProperty(globalThis, "localStorage", {
      value: storage,
      configurable: true,
      writable: true,
    });
    return store;
  }

  test("defaults to false when unset or unknown", () => {
    const store = installStorage();
    expect(readShowJoinedChannelsOnly()).toBe(false);
    store.set("coforge-chat-joined-channels-only", "unexpected");
    expect(readShowJoinedChannelsOnly()).toBe(false);
  });

  test("round-trips true and false", () => {
    installStorage();
    writeShowJoinedChannelsOnly(true);
    expect(readShowJoinedChannelsOnly()).toBe(true);
    writeShowJoinedChannelsOnly(false);
    expect(readShowJoinedChannelsOnly()).toBe(false);
  });
});
