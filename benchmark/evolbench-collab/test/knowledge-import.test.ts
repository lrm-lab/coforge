import { expect, test } from "bun:test";
import { createEvalRuntime, userIdentity } from "../../public-channel-memory/src/ov";
import { importKnowledgeResource } from "../src/knowledge-import";

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
