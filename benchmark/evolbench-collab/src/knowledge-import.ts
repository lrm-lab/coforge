import { open } from "node:fs/promises";
import type { OpenVikingRuntimeClient } from "../../../apps/web/src/server/openviking/runtime-client.server";
import type { ServerOpenVikingIdentity } from "../../../apps/web/src/server/openviking/route-policy";
import { knowledgeResource, validateKnowledgeReady, type KnowledgeReady } from "./knowledge";

class KnowledgeTransportError extends Error {
  constructor(readonly code: string) {
    super(`knowledge import transport: ${code}`);
  }
}

async function jsonRequest(
  runtime: OpenVikingRuntimeClient,
  identity: ServerOpenVikingIdentity,
  path: string,
  body: string | Uint8Array,
  contentType: string,
  method = "POST",
) {
  const result = await runtime.request({
    method,
    path,
    identity,
    body: method === "GET" ? undefined : body,
    headers: { "content-type": contentType },
  });
  if (!result.ok) throw new KnowledgeTransportError(result.failure.code);
  const payload = (await new Response(result.response.body).json()) as {
    status?: string;
    result?: Record<string, unknown>;
  };
  if (
    result.response.status >= 300 ||
    payload.status !== "ok" ||
    !payload.result ||
    payload.result.status === "error" ||
    payload.result.status === "cancelled"
  ) {
    throw new Error(`knowledge import failed at ${path}, HTTP ${result.response.status}`);
  }
  return payload.result;
}

/** Index raw resources with BM25; this path schedules no embedding or semantic jobs. */
export async function importKnowledgeResources(
  runtime: OpenVikingRuntimeClient,
  identity: ServerOpenVikingIdentity,
  resources: { uri: string; text: string }[],
) {
  let result: Record<string, unknown>;
  try {
    result = await jsonRequest(
      runtime,
      identity,
      "/api/v1/search/index_lexical",
      JSON.stringify({
        resources: resources.map((resource) => ({
          ...resource,
          kind: resource.uri.includes("/experiences/") ? "experience" : "document",
        })),
      }),
      "application/json",
    );
  } catch (error) {
    if (
      error instanceof KnowledgeTransportError &&
      error.code === "request_too_large" &&
      resources.length > 1
    ) {
      const middle = Math.floor(resources.length / 2);
      await importKnowledgeResources(runtime, identity, resources.slice(0, middle));
      await importKnowledgeResources(runtime, identity, resources.slice(middle));
      return;
    }
    throw error;
  }
  if (
    result.retrieval_mode !== "bm25" ||
    !Array.isArray(result.resources) ||
    result.resources.length !== resources.length
  )
    throw new Error("knowledge import requires verified BM25 resources");
  const hashes = new Map(
    result.resources.map((row: { uri: string; content_hash: string }) => [
      row.uri,
      row.content_hash,
    ]),
  );
  for (const resource of resources) {
    const hash = "sha256:" + new Bun.CryptoHasher("sha256").update(resource.text).digest("hex");
    if (hashes.get(resource.uri) !== hash) throw new Error("knowledge content hash mismatch");
  }
}

export async function importKnowledgeResource(
  runtime: OpenVikingRuntimeClient,
  identity: ServerOpenVikingIdentity,
  resource: { uri: string; text: string },
) {
  await importKnowledgeResources(runtime, identity, [resource]);
}

async function* lines(path: string) {
  const reader = Bun.file(path).stream().pipeThrough(new TextDecoderStream()).getReader();
  let pending = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += value;
      let end: number;
      while ((end = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        if (line.trim()) yield line;
      }
    }
    if (pending.trim()) yield pending;
  } finally {
    reader.releaseLock();
  }
}

async function digest(path: string) {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  return hasher.digest("hex");
}

/** Resumable host preparation. Ready is written only after every resource succeeds. */
export async function prepareKnowledge(input: {
  runtime: OpenVikingRuntimeClient;
  identity: ServerOpenVikingIdentity;
  accountCreatedAt: string;
  corpusPath: string;
  ledgerPath: string;
  readyPath: string;
  expectedDocuments: number;
  expectedExperiences: number;
}) {
  // Revoke readiness before any input/checkpoint operation can fail.
  if (await Bun.file(input.readyPath).exists()) await Bun.file(input.readyPath).delete();
  const corpusSha256 = await digest(input.corpusPath);
  const ledgerSha256 = await digest(input.ledgerPath);
  const checkpointPath = `${input.readyPath}.checkpoint.jsonl`;
  const signature = JSON.stringify({
    accountId: input.identity.accountId,
    accountCreatedAt: input.accountCreatedAt,
    corpusSha256,
    ledgerSha256,
    processingMode: "bm25",
  });
  const done = new Set<string>();
  if (await Bun.file(checkpointPath).exists()) {
    const saved = (await Bun.file(checkpointPath).text()).trim().split("\n");
    if (saved.shift() !== signature) throw new Error("knowledge checkpoint input/account mismatch");
    for (const line of saved) {
      const row = JSON.parse(line) as { uri: string; taskId?: string; completed?: boolean };
      if (row.completed) done.add(row.uri);
    }
  } else {
    await Bun.write(checkpointPath, `${signature}\n`);
  }
  const checkpoint = await open(checkpointPath, "a");
  const seen = new Set<string>();
  let documents = 0,
    experiences = 0;
  let pending: { uri: string; text: string }[] = [];
  const flush = async () => {
    if (!pending.length) return;
    await importKnowledgeResources(input.runtime, input.identity, pending);
    for (const resource of pending) {
      await checkpoint.write(`${JSON.stringify({ uri: resource.uri, completed: true })}\n`);
      done.add(resource.uri);
    }
    await checkpoint.sync();
    pending = [];
  };
  const add = async (kind: "document" | "experience", row: Record<string, unknown>) => {
    const resource = knowledgeResource(kind, row);
    if (seen.has(resource.uri)) throw new Error("duplicate knowledge resource");
    seen.add(resource.uri);
    if (!done.has(resource.uri)) pending.push(resource);
    if (pending.length === 50) await flush();
  };
  try {
    for await (const line of lines(input.corpusPath)) {
      await add("document", JSON.parse(line));
      documents++;
    }
    const ledger = (await Bun.file(input.ledgerPath).json()) as unknown;
    if (!Array.isArray(ledger)) throw new Error("knowledge ledger must be an array");
    for (const row of ledger) {
      await add("experience", row);
      experiences++;
    }
    await flush();
    const indexed = await jsonRequest(
      input.runtime,
      input.identity,
      "/api/v1/search/index_lexical",
      "",
      "application/json",
      "GET",
    );
    if (
      indexed.retrieval_mode !== "bm25" ||
      indexed.document !== documents ||
      (indexed.experience ?? 0) !== experiences
    )
      throw new Error("knowledge index count mismatch");
    if (
      Object.keys(indexed).some(
        (kind) => !["retrieval_mode", "document", "experience"].includes(kind),
      )
    )
      throw new Error("frozen knowledge contains untracked resource kinds");
    if (documents !== input.expectedDocuments || experiences !== input.expectedExperiences)
      throw new Error("knowledge count mismatch");
    const ready: KnowledgeReady = validateKnowledgeReady({
      version: 2,
      arm: experiences === 0 ? "cold" : "warm",
      accountId: input.identity.accountId,
      accountCreatedAt: input.accountCreatedAt,
      documents,
      experiences,
      corpusSha256,
      ledgerSha256,
      processingMode: "bm25",
      completed: true,
    });
    await Bun.write(input.readyPath, JSON.stringify(ready, null, 2));
    return ready;
  } finally {
    await checkpoint.close();
  }
}
