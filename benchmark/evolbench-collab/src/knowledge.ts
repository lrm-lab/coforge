/** Host-only input projection: neither labels nor grader fields reach retrieval. */
export function knowledgeResource(kind: "document" | "experience", row: Record<string, unknown>) {
  const id = kind === "document" ? row.docid : row.sha256;
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(id))
    throw new Error("invalid knowledge id");
  if (typeof row.text !== "string" || !row.text.trim()) throw new Error("empty knowledge text");
  return {
    uri: `viking://resources/evo-ir/${kind === "document" ? "documents" : "experiences"}/${id}.md`,
    text:
      kind === "document" && typeof row.url === "string"
        ? `Source: ${row.url}\n\n${row.text}`
        : row.text,
  };
}

export type KnowledgeReady = {
  version: 1;
  accountId: string;
  documents: number;
  experiences: number;
  corpusSha256: string;
  ledgerSha256: string;
  processingMode: "semantic_and_vectors";
  completed: true;
};

export function validateKnowledgeReady(value: unknown): KnowledgeReady {
  const row = value as Partial<KnowledgeReady> | null;
  if (
    !row ||
    row.version !== 1 ||
    row.completed !== true ||
    row.processingMode !== "semantic_and_vectors" ||
    typeof row.accountId !== "string" ||
    !/^[a-zA-Z0-9_-]+$/.test(row.accountId) ||
    !Number.isInteger(row.documents) ||
    row.documents! < 1 ||
    !Number.isInteger(row.experiences) ||
    row.experiences! < 1 ||
    !/^[a-f0-9]{64}$/.test(row.corpusSha256 ?? "") ||
    !/^[a-f0-9]{64}$/.test(row.ledgerSha256 ?? "")
  ) {
    throw new Error("IR requires completed document and experience knowledge preparation");
  }
  return row as KnowledgeReady;
}
