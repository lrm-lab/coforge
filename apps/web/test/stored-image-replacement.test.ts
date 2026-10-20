import { expect, test } from "bun:test";

import type { FileStorage } from "#src/server/files/file-storage.server";
import { replaceStoredImage } from "#src/server/files/stored-image-replacement.server";

/** A store that keeps objects in memory and records what was written and removed. */
function recordingStorage(initial: string[] = []) {
  const objects = new Map<string, Blob>(initial.map((key) => [key, new Blob(["old"])]));
  const removed: string[] = [];
  const storage: FileStorage = {
    put: async (key, file) => {
      objects.set(key, file);
    },
    open: async () => null,
    remove: async (key) => {
      removed.push(key);
      objects.delete(key);
    },
    head: async () => null,
  };
  return { objects, removed, storage };
}

const image = new Blob(["new"], { type: "image/png" });

test("a committed replacement keeps the new object and removes the one it replaced", async () => {
  const { objects, removed, storage } = recordingStorage(["old/original"]);
  const committed: string[] = [];
  const failures: unknown[] = [];

  await replaceStoredImage({
    storage,
    objectKey: "new/original",
    file: image,
    contentType: "image/png",
    previousObjectKey: "old/original",
    commit: async () => {
      // The row moves only once the new object is in the store.
      committed.push(...objects.keys());
    },
    reportRemovalFailure: (error) => failures.push(error),
  });

  expect(committed).toEqual(["old/original", "new/original"]);
  expect([...objects.keys()]).toEqual(["new/original"]);
  expect(removed).toEqual(["old/original"]);
  expect(failures).toEqual([]);
});

test("without an image before it, nothing else is removed", async () => {
  const { objects, removed, storage } = recordingStorage();

  await replaceStoredImage({
    storage,
    objectKey: "new/original",
    file: image,
    contentType: "image/png",
    previousObjectKey: null,
    commit: async () => {},
    reportRemovalFailure: () => {},
  });

  expect([...objects.keys()]).toEqual(["new/original"]);
  expect(removed).toEqual([]);
});

test("a replacement that loses its race removes the new object, keeps the old one, and rethrows", async () => {
  const { objects, removed, storage } = recordingStorage(["old/original"]);
  const lost = new Error("lost the race");
  const failures: unknown[] = [];

  const outcome = replaceStoredImage({
    storage,
    objectKey: "new/original",
    file: image,
    contentType: "image/png",
    previousObjectKey: "old/original",
    commit: async () => {
      throw lost;
    },
    reportRemovalFailure: (error) => failures.push(error),
  });

  await expect(outcome).rejects.toBe(lost);
  expect([...objects.keys()]).toEqual(["old/original"]);
  expect(removed).toEqual(["new/original"]);
  expect(failures).toEqual([]);
});

test("an old object that cannot be removed is reported, and the committed change stands", async () => {
  const { objects, storage } = recordingStorage(["old/original"]);
  const broken = new Error("store down");
  storage.remove = async () => {
    throw broken;
  };
  const failures: unknown[] = [];

  await replaceStoredImage({
    storage,
    objectKey: "new/original",
    file: image,
    contentType: "image/png",
    previousObjectKey: "old/original",
    commit: async () => {},
    reportRemovalFailure: (error) => failures.push(error),
  });

  expect(objects.has("new/original")).toBe(true);
  expect(failures).toEqual([broken]);
});
