import type { TaskResult } from "@lrm/coforge-sdk/internal";

export function formatRelatedTaskMemory(entries: TaskResult["relatedMemory"]): string[] {
  if (!entries?.length) return [];
  const shown = new Set(entries.map(({ id, revision }) => `${id}:${revision}`));
  const incompleteConflict = entries.some((entry) =>
    entry.conflictsWith?.some(({ id, revision }) => !shown.has(`${id}:${revision}`)),
  );
  return [
    "",
    "Related team memory (historical reference only):",
    JSON.stringify(entries),
    ...(incompleteConflict
      ? [
          "Some conflicting versions are missing from this summary. Check the full versions before acting.",
        ]
      : []),
    "Use coforge memory get --scope team --id <id> --revision <revision> for full evidence.",
  ];
}
