import type { TeamMemoryDraft } from "@lrm/coforge-sdk/agent";

type TaskResult = {
  id: string;
  revision: number;
  status: string;
  title: string;
  description: string | null;
  projectId: string | null;
};

export function taskMemorySuggestion(task: TaskResult) {
  if (task.status !== "done") return undefined;
  const draft: TeamMemoryDraft = {
    title: task.title.trim().slice(0, 200),
    content: [
      "This task was accepted as done.",
      ...(task.description?.trim() ? [`Task description:\n${task.description.trim()}`] : []),
    ]
      .join("\n\n")
      .slice(0, 16_000),
    source: "Accepted Workspace task",
    kind: "fact",
    applicability: "",
    projectId: task.projectId,
    evidence: [{ kind: "task", id: task.id, revision: task.revision }],
  };
  return { key: `task:${task.id}:${task.revision}`, draft };
}

type DuplicateRecord = {
  id: string;
  revision: number;
  title: string;
  content: string;
  kind: string;
  applicability: string;
  projectId: string | null;
  pinned: boolean;
};

export function normalizedMemoryContent(content: string) {
  return content.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

export function duplicateMemorySuggestions(entries: readonly DuplicateRecord[], limit = 5) {
  const seen = new Map<string, DuplicateRecord>();
  const results: {
    key: string;
    keep: { id: string; revision: number };
    duplicate: { id: string; revision: number };
  }[] = [];
  for (const entry of entries) {
    if (entry.pinned) continue;
    const text = normalizedMemoryContent(entry.content);
    if (!text) continue;
    const key = JSON.stringify([entry.projectId, entry.applicability, entry.kind, text]);
    const existing = seen.get(key);
    if (!existing) seen.set(key, entry);
    else {
      const keep = { id: existing.id, revision: existing.revision };
      const duplicate = { id: entry.id, revision: entry.revision };
      results.push({
        key: `duplicate:${keep.id}:${keep.revision}:${duplicate.id}:${duplicate.revision}`,
        keep,
        duplicate,
      });
      if (results.length >= limit) break;
    }
  }
  return results;
}
