import { open } from "node:fs/promises";
import type { OpenVikingRuntimeClient } from "../../../apps/web/src/server/openviking/runtime-client.server";
import type { ServerOpenVikingIdentity } from "../../../apps/web/src/server/openviking/route-policy";
import { knowledgeResource, validateKnowledgeReady, type KnowledgeReady } from "./knowledge";

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
  if (!result.ok) throw new Error(`knowledge import transport: ${result.failure.code}`);
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

/** Upload through the server API, waiting for production semantic/vector processing. */
export async function importKnowledgeResource(
  runtime: OpenVikingRuntimeClient,
  identity: ServerOpenVikingIdentity,
  resource: { uri: string; text: string },
  progress?: { taskId?: string; submitted(taskId: string): Promise<void> },
) {
  let taskId = progress?.taskId;
  let result: Record<string, unknown>;
  if (!taskId) {
    const form = new FormData();
    form.append("file", new File([resource.text], "source.md", { type: "text/markdown" }));
    const upload = new Response(form);
    const contentType = upload.headers.get("content-type")!;
    const temp = await jsonRequest(
      runtime,
      identity,
      "/api/v1/resources/temp_upload",
      new Uint8Array(await upload.arrayBuffer()),
      contentType,
    );
    if (typeof temp.temp_file_id !== "string")
      throw new Error("knowledge upload missing temp_file_id");
    result = await jsonRequest(
      runtime,
      identity,
      "/api/v1/resources",
      JSON.stringify({
        temp_file_id: temp.temp_file_id,
        to: resource.uri,
        create_parent: true,
        wait: false,
        processing_mode: "semantic_and_vectors",
      }),
      "application/json",
    );
    if (typeof result.task_id !== "string") throw new Error("knowledge import missing task_id");
    taskId = result.task_id;
    await progress?.submitted(taskId);
  }
  const deadline = Date.now() + 900_000;
  while (true) {
    const task = await jsonRequest(
      runtime,
      identity,
      `/api/v1/tasks/${encodeURIComponent(taskId)}`,
      "",
      "application/json",
      "GET",
    );
    if (task.status === "completed") {
      const completed = task.result as Record<string, unknown> | undefined;
      if (completed?.root_uri !== resource.uri)
        throw new Error("knowledge import returned an unexpected root_uri");
      const summaryResponse = await runtime.request({
        method: "GET",
        path: "/api/v1/content/read",
        query: { uri: `${resource.uri}/.overview.md` },
        identity,
      });
      if (!summaryResponse.ok || summaryResponse.response.status !== 200)
        throw new Error("semantic summary unavailable");
      const summary = (await new Response(summaryResponse.response.body).json()) as {
        status?: string;
        result?: unknown;
      };
      if (
        summary.status !== "ok" ||
        typeof summary.result !== "string" ||
        !summary.result.trim() ||
        summary.result.includes("[Directory overview is not generated]")
      )
        throw new Error("semantic summary unavailable; repair processing before resuming");
      return;
    }
    if (task.status === "failed" || task.status === "cancelled")
      throw new Error(`knowledge processing ${task.status}`);
    if (Date.now() >= deadline)
      throw new Error("knowledge processing deadline; resume using saved task id");
    await Bun.sleep(5000);
  }
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
  });
  const done = new Set<string>();
  const tasks = new Map<string, string>();
  if (await Bun.file(checkpointPath).exists()) {
    const saved = (await Bun.file(checkpointPath).text()).trim().split("\n");
    if (saved.shift() !== signature) throw new Error("knowledge checkpoint input/account mismatch");
    for (const line of saved) {
      const row = JSON.parse(line) as { uri: string; taskId?: string; completed?: boolean };
      if (row.completed) done.add(row.uri);
      if (row.taskId) tasks.set(row.uri, row.taskId);
    }
  } else {
    await Bun.write(checkpointPath, `${signature}\n`);
  }
  const checkpoint = await open(checkpointPath, "a");
  const seen = new Set<string>();
  let documents = 0,
    experiences = 0;
  const add = async (kind: "document" | "experience", row: Record<string, unknown>) => {
    const resource = knowledgeResource(kind, row);
    if (seen.has(resource.uri)) throw new Error("duplicate knowledge resource");
    seen.add(resource.uri);
    if (!done.has(resource.uri)) {
      await importKnowledgeResource(input.runtime, input.identity, resource, {
        taskId: tasks.get(resource.uri),
        async submitted(taskId) {
          await checkpoint.write(`${JSON.stringify({ uri: resource.uri, taskId })}\n`);
          await checkpoint.sync();
        },
      });
      await checkpoint.write(`${JSON.stringify({ uri: resource.uri, completed: true })}\n`);
      await checkpoint.sync();
    }
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
    if (documents !== input.expectedDocuments || experiences !== input.expectedExperiences)
      throw new Error("knowledge count mismatch");
    const ready: KnowledgeReady = validateKnowledgeReady({
      version: 1,
      accountId: input.identity.accountId,
      accountCreatedAt: input.accountCreatedAt,
      documents,
      experiences,
      corpusSha256,
      ledgerSha256,
      processingMode: "semantic_and_vectors",
      completed: true,
    });
    await Bun.write(input.readyPath, JSON.stringify(ready, null, 2));
    return ready;
  } finally {
    await checkpoint.close();
  }
}
