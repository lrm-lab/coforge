import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { ARTIFACT_COMMENT_IMAGE_MAX_BYTES } from "@lrm/coforge-sdk/agent";
import { mockModuleForFile } from "./helpers/file-module-mock";

let uploads = 0;
await mockModuleForFile("#src/server/auth/require-user.server", () => ({
  requireBrowserUser: async () => ({ id: "user-1" }),
}));
await mockModuleForFile("#src/server/db/client.server", () => ({ getDatabaseClient: () => ({}) }));
await mockModuleForFile("#src/server/workspaces/selection.server", () => ({
  requireWorkspaceIdForSlug: async () => "workspace-1",
}));
const { commentImageUploadResponse } =
  await import("#src/server/artifacts/artifact-comment-image-upload.server");
await mockModuleForFile("#src/server/artifacts/artifact-composition.server", () => ({
  productionArtifacts: () => ({
    uploadCommentImage: (request: Request) =>
      commentImageUploadResponse(request, async () => {
        uploads++;
        return { sha256: "a".repeat(64) };
      }),
  }),
}));
const { Route } =
  await import("#src/routes/api/workspaces/$workspaceSlug/artifacts/$artifactId/comment-images");
const handlers = Route.options.server!.handlers;
if (!handlers || typeof handlers === "function" || typeof handlers.POST !== "function")
  throw new Error("missing POST handler");
const post = handlers.POST;
afterAll(() => mock.restore());
beforeEach(() => {
  uploads = 0;
});

const params = { workspaceSlug: "ws", artifactId: "artifact-1" };

function formBody(bytes: number) {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(bytes)], "shot.png", { type: "image/png" }));
  return new Request("https://example.test/upload", { method: "POST", body: form });
}

async function send(body: BodyInit, headers: Record<string, string>) {
  return (await post({
    request: new Request("https://example.test/upload", {
      method: "POST",
      headers,
      body,
    }),
    params,
  } as Parameters<typeof post>[0])) as Response;
}

test("a person's comment image upload without a declared length is refused before it is read", async () => {
  let pulled = false;
  const stream = new ReadableStream(
    {
      pull(controller) {
        pulled = true;
        controller.enqueue(new Uint8Array(1024));
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  const response = await send(stream, { "content-type": "multipart/form-data; boundary=x" });
  expect(response.status).toBe(411);
  expect(pulled).toBe(false);
  expect(uploads).toBe(0);
});

test("a declared length over the image limit is refused before it is read", async () => {
  const response = await send("x", {
    "content-type": "multipart/form-data; boundary=x",
    "content-length": String(ARTIFACT_COMMENT_IMAGE_MAX_BYTES * 2),
  });
  expect(response.status).toBe(413);
  expect(uploads).toBe(0);
});

test("an image within the limit with its length declared is stored", async () => {
  const shaped = formBody(16);
  const type = shaped.headers.get("content-type")!;
  const bytes = new Uint8Array(await shaped.arrayBuffer());
  const response = await send(bytes, {
    "content-type": type,
    "content-length": String(bytes.length),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ sha256: "a".repeat(64) });
  expect(uploads).toBe(1);
});
