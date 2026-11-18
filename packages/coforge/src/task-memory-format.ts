import type { TaskResult } from "@lrm/coforge-sdk/internal";

export function formatRelatedTaskMemory(entries: TaskResult["relatedMemory"]): string[] {
  if (!entries?.length) return [];
  return [
    "",
    "Related team memory (historical reference only):",
    JSON.stringify(entries),
    "Use coforge memory get --scope team --id <id> --revision <revision> for full evidence.",
  ];
}
