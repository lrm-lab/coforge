import type { TreeEntryType } from "./tree-index";

type RootEntry = { name: string; path: string; type: TreeEntryType };

/** Preference order: a `README.md` wins over a `README.markdown`. */
const README_NAMES = ["readme.md", "readme.markdown"];

/**
 * The Markdown README of a repository's root, which the project page renders under its Files.
 * Only a regular file at the root counts: a folder, a symlink, or a README nested in a
 * subdirectory is not the project's README.
 */
export function findReadmeEntry<T extends RootEntry>(entries: ReadonlyArray<T>): T | null {
  const candidates = entries.filter((entry) => entry.type === "file" && entry.path === entry.name);
  for (const readmeName of README_NAMES) {
    const match = candidates.find((entry) => entry.name.toLowerCase() === readmeName);
    if (match) return match;
  }
  return null;
}
