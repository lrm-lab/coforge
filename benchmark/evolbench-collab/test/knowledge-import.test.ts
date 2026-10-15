import { expect, test } from "bun:test";
import { createEvalRuntime, userIdentity } from "../../public-channel-memory/src/ov";
import { importKnowledgeResource, prepareKnowledge } from "../src/knowledge-import";

test("HTTP success with failed vector processing is rejected", async () => {
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      return Response.json({
        status: "ok",
        result: request.url.endsWith("temp_upload")
          ? { temp_file_id: "temp-1" }
          : { status: "error", errors: ["embedding unavailable"] },
      });
    },
  });
  try {
    await expect(
      importKnowledgeResource(
        createEvalRuntime(server.url.toString()),
        userIdentity("test-account", "owner", "test-key"),
        { uri: "viking://resources/evo-ir/documents/d1.md", text: "Evidence" },
      ),
    ).rejects.toThrow("knowledge import failed");
  } finally {
    server.stop(true);
  }
});

test("resource upload carries the file and waits for semantic/vector processing", async () => {
  let received = "";
  let processing: unknown;
  const uri = "viking://resources/evo-ir/documents/d1.md";
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (request.url.endsWith("temp_upload")) {
        const file = (await request.formData()).get("file");
        received = file instanceof File ? await file.text() : "";
        return Response.json({ status: "ok", result: { temp_file_id: "upload-1" } });
      }
      if (request.method === "GET")
        return Response.json({
          status: "ok",
          result: { status: "completed", result: { root_uri: uri } },
        });
      processing = await request.json();
      return Response.json({ status: "ok", result: { root_uri: uri, task_id: "task-1" } });
    },
  });
  try {
    await importKnowledgeResource(
      createEvalRuntime(server.url.toString()),
      userIdentity("test-account", "owner", "test-key"),
      { uri, text: "Evidence text" },
    );
    expect(received).toBe("Evidence text");
    expect(processing).toMatchObject({
      temp_file_id: "upload-1",
      to: uri,
      wait: false,
      processing_mode: "semantic_and_vectors",
    });
  } finally {
    server.stop(true);
  }
});

test("an accepted ingestion task is not ready before vector processing completes", async () => {
  const uri = "viking://resources/evo-ir/documents/d1.md";
  let checked = false;
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      if (request.url.endsWith("temp_upload"))
        return Response.json({ status: "ok", result: { temp_file_id: "upload-1" } });
      if (request.method === "GET") {
        checked = true;
        return Response.json({
          status: "ok",
          result: { status: "completed", result: { root_uri: uri } },
        });
      }
      return Response.json({ status: "ok", result: { task_id: "processing-1", root_uri: uri } });
    },
  });
  try {
    await importKnowledgeResource(
      createEvalRuntime(server.url.toString()),
      userIdentity("test-account", "owner", "test-key"),
      { uri, text: "Evidence text" },
    );
    expect(checked).toBe(true);
  } finally {
    server.stop(true);
  }
});

test("failed preparation revokes a previous ready file before reading inputs", async () => {
  const path = `/tmp/knowledge-ready-${crypto.randomUUID()}.json`;
  await Bun.write(path, '{"completed":true}');
  try {
    await expect(
      prepareKnowledge({
        runtime: createEvalRuntime("http://127.0.0.1:1"),
        identity: userIdentity("account", "owner", "key"),
        accountCreatedAt: "2026-10-15T00:00:00Z",
        corpusPath: `${path}.missing`,
        ledgerPath: `${path}.missing`,
        readyPath: path,
        expectedDocuments: 1,
        expectedExperiences: 1,
      }),
    ).rejects.toThrow();
    expect(await Bun.file(path).exists()).toBe(false);
  } finally {
    if (await Bun.file(path).exists()) await Bun.file(path).delete();
  }
});

test("recreating the same account cannot reuse completed knowledge checkpoints", async () => {
  const prefix = `/tmp/knowledge-generation-${crypto.randomUUID()}`;
  const uriByTask = new Map<string, string>();
  let uploads = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (request.url.endsWith("temp_upload")) {
        uploads++;
        return Response.json({ status: "ok", result: { temp_file_id: `upload-${uploads}` } });
      }
      if (request.method === "GET") {
        const id = new URL(request.url).pathname.split("/").at(-1)!;
        return Response.json({
          status: "ok",
          result: { status: "completed", result: { root_uri: uriByTask.get(id) } },
        });
      }
      const input = (await request.json()) as { to: string };
      const id = `task-${uploads}`;
      uriByTask.set(id, input.to);
      return Response.json({ status: "ok", result: { task_id: id } });
    },
  });
  const input = {
    runtime: createEvalRuntime(server.url.toString()),
    identity: userIdentity("same-account", "owner", "key"),
    accountCreatedAt: "2026-10-15T00:00:00Z",
    corpusPath: `${prefix}.corpus`,
    ledgerPath: `${prefix}.ledger`,
    readyPath: `${prefix}.ready`,
    expectedDocuments: 1,
    expectedExperiences: 1,
  };
  try {
    await Bun.write(input.corpusPath, JSON.stringify({ docid: "d1", text: "Evidence" }));
    await Bun.write(
      input.ledgerPath,
      JSON.stringify([{ sha256: "a".repeat(64), text: "Experience" }]),
    );
    await prepareKnowledge(input);
    expect(uploads).toBe(2);
    await expect(
      prepareKnowledge({ ...input, accountCreatedAt: "2026-10-15T01:00:00Z" }),
    ).rejects.toThrow("checkpoint input/account mismatch");
    expect(await Bun.file(input.readyPath).exists()).toBe(false);
    expect(uploads).toBe(2);
  } finally {
    server.stop(true);
    for (const path of [
      input.corpusPath,
      input.ledgerPath,
      input.readyPath,
      `${input.readyPath}.checkpoint.jsonl`,
    ])
      if (await Bun.file(path).exists()) await Bun.file(path).delete();
  }
});
