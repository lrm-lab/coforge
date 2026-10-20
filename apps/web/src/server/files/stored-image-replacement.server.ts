import type { FileStorage } from "./file-storage.server";

/**
 * Replaces the image a row names with a new stored object: writes the object, lets `commit` move
 * the row to it, then removes the object the row named before. The row's owner keeps its own
 * authorization, key layout and error mapping in `commit`.
 *
 * - `commit` throws when the change did not apply (typically a compare-and-set on
 *   `previousObjectKey` that another change beat); the new object is then removed and the error
 *   rethrown, so a lost race leaves nothing behind.
 * - Once `commit` returns the change stands, so removing the old object is best effort: a failure
 *   goes to `reportRemovalFailure` instead of undoing the result. `previousObjectKey` is `null`
 *   when no stored object is replaced.
 */
export async function replaceStoredImage(input: {
  storage: FileStorage;
  objectKey: string;
  file: Blob;
  contentType: string;
  previousObjectKey: string | null;
  commit: () => Promise<void>;
  reportRemovalFailure: (error: unknown) => void;
}): Promise<void> {
  const { storage, objectKey, previousObjectKey } = input;
  await storage.put(objectKey, input.file, input.contentType);
  try {
    await input.commit();
  } catch (error) {
    await storage.remove(objectKey);
    throw error;
  }
  if (!previousObjectKey) return;
  try {
    await storage.remove(previousObjectKey);
  } catch (error) {
    input.reportRemovalFailure(error);
  }
}
