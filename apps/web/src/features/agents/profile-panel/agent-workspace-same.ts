import type {
  AgentWorkspaceFileEntry,
  AgentWorkspaceFileReadResult,
} from "@lrm/coforge-sdk/internal";

// A quiet refresh reads everything again, and most of it is unchanged. These say so, so the caller
// can keep the object already on screen: a new object, even an equal one, redraws what is built
// from it (an image preview reloads and flashes).

export function sameEntries(a: AgentWorkspaceFileEntry[], b: AgentWorkspaceFileEntry[]): boolean {
  return (
    a.length === b.length &&
    a.every((entry, index) => {
      const other = b[index];
      return (
        other !== undefined &&
        entry.name === other.name &&
        entry.type === other.type &&
        entry.sizeBytes === other.sizeBytes &&
        entry.modifiedAtMs === other.modifiedAtMs
      );
    })
  );
}

export function sameFileRead(
  a: AgentWorkspaceFileReadResult,
  b: AgentWorkspaceFileReadResult,
): boolean {
  return (
    a.sizeBytes === b.sizeBytes &&
    a.modifiedAtMs === b.modifiedAtMs &&
    a.contentType === b.contentType &&
    a.text === b.text &&
    a.contentBase64 === b.contentBase64
  );
}
