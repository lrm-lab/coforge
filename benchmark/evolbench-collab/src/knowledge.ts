import type { OpenVikingRuntimeClient } from "../../../apps/web/src/server/openviking/runtime-client.server";
import type { ServerOpenVikingIdentity } from "../../../apps/web/src/server/openviking/route-policy";
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
  version: 2;
  arm: "warm" | "cold";
  accountId: string;
  accountCreatedAt: string;
  documents: number;
  experiences: number;
  corpusSha256: string;
  ledgerSha256: string;
  processingMode: "bm25";
  completed: true;
};

export function validateKnowledgeReady(value: unknown): KnowledgeReady {
  const row = value as Partial<KnowledgeReady> | null;
  if (
    !row ||
    row.version !== 2 ||
    row.completed !== true ||
    row.processingMode !== "bm25" ||
    typeof row.accountCreatedAt !== "string" ||
    !Number.isFinite(Date.parse(row.accountCreatedAt)) ||
    typeof row.accountId !== "string" ||
    !/^[a-zA-Z0-9_-]+$/.test(row.accountId) ||
    !Number.isInteger(row.documents) ||
    row.documents! < 1 ||
    !Number.isInteger(row.experiences) ||
    row.experiences! < 0 ||
    (row.arm !== "warm" && row.arm !== "cold") ||
    (row.arm === "warm" ? row.experiences! < 1 : row.experiences !== 0) ||
    !/^[a-f0-9]{64}$/.test(row.corpusSha256 ?? "") ||
    !/^[a-f0-9]{64}$/.test(row.ledgerSha256 ?? "")
  ) {
    throw new Error("IR requires completed document and experience knowledge preparation");
  }
  return row as KnowledgeReady;
}

export async function readKnowledgeAccountCreatedAt(
  runtime: OpenVikingRuntimeClient,
  root: ServerOpenVikingIdentity,
  accountId: string,
): Promise<string> {
  const response = await runtime.request({
    method: "GET",
    path: "/api/v1/admin/accounts",
    identity: root,
  });
  if (!response.ok || response.response.status !== 200)
    throw new Error("cannot verify knowledge account generation");
  const payload = (await new Response(response.response.body).json()) as {
    result?: { account_id: string; created_at: string }[];
  };
  const account = payload.result?.find((row) => row.account_id === accountId);
  if (!account?.created_at) throw new Error("prepared knowledge account no longer exists");
  return account.created_at;
}
