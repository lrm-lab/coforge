import { afterEach, describe, expect, test } from "bun:test";

import {
  DEFAULT_BUILT_IN_SORT_MODES,
  directorySectionHideable,
  readBuiltInSectionSortModes,
  writeBuiltInSectionSortModes,
} from "./directory-sections";

describe("an empty sidebar section under Hide empty sidebar sections", () => {
  test("a section with rows is never hidden", () => {
    expect(directorySectionHideable({ itemCount: 2, dragging: false })).toBe(false);
  });

  test("an empty section is hidden", () => {
    expect(directorySectionHideable({ itemCount: 0, dragging: false })).toBe(true);
  });

  test("an empty section that takes drops comes back while a row is dragged", () => {
    expect(
      directorySectionHideable({ itemCount: 0, dragging: true, revealWhileDragging: true }),
    ).toBe(false);
  });

  test("an empty section that takes no drops stays hidden while a row is dragged", () => {
    expect(directorySectionHideable({ itemCount: 0, dragging: true })).toBe(true);
  });
});

describe("built-in sidebar section sort modes", () => {
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

  test("returns defaults when storage is empty or malformed", () => {
    const store = installStorage();
    expect(readBuiltInSectionSortModes()).toEqual(DEFAULT_BUILT_IN_SORT_MODES);

    store.set("coforge-chat-sections-sort", "{not-json");
    expect(readBuiltInSectionSortModes()).toEqual(DEFAULT_BUILT_IN_SORT_MODES);

    store.set("coforge-chat-sections-sort", JSON.stringify(["invalid"]));
    expect(readBuiltInSectionSortModes()).toEqual(DEFAULT_BUILT_IN_SORT_MODES);
  });

  test("round-trips valid sort modes and rejects disallowed values per section", () => {
    const store = installStorage();
    writeBuiltInSectionSortModes({ pinned: "recent", channels: "recent", agents: "alpha" });
    expect(readBuiltInSectionSortModes()).toEqual({
      pinned: "recent",
      channels: "recent",
      agents: "alpha",
    });

    store.set(
      "coforge-chat-sections-sort",
      JSON.stringify({ pinned: "alpha", channels: "manual", agents: "bogus" }),
    );
    expect(readBuiltInSectionSortModes()).toEqual({
      pinned: "alpha",
      channels: "alpha",
      agents: "recent",
    });
  });
});
