import { expect, test } from "bun:test";
import { storeAttachment, storeAgentAttachment } from "#src/server/attachments/attachment.server";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==",
  "base64",
);

test("a browser image upload persists dimensions read from its bytes", async () => {
  let persisted: Record<string, unknown> | undefined;
  const db = {
    conversation: { findFirst: async () => ({ id: "c", workspaceId: "w" }) },
    attachment: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        persisted = data;
        return { id: data.id };
      },
    },
  };
  await storeAttachment(
    db as never,
    { userId: "u", conversationId: "c", file: new File([png], "pixel.png", { type: "image/png" }) },
    async () => ({
      put: async () => {},
      remove: async () => {},
      head: async () => null,
      open: async () => null,
    }),
  );
  expect(persisted).toMatchObject({ imageWidth: 1, imageHeight: 1 });
});

test("an Agent multipart upload persists the same image dimensions without changing its response", async () => {
  let persisted: Record<string, unknown> | undefined;
  const db = {
    attachment: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        persisted = data;
        return {
          id: data.id,
          fileName: data.fileName,
          contentType: data.contentType,
          sizeBytes: data.sizeBytes,
        };
      },
    },
  };
  const result = await storeAgentAttachment(
    db as never,
    {
      agentId: "a",
      workspaceId: "w",
      conversationId: "c",
      contentType: "image/png",
      file: new File([png], "pixel.png", { type: "image/png" }),
    },
    async () => ({
      put: async () => {},
      remove: async () => {},
      head: async () => null,
      open: async () => null,
    }),
  );
  expect(persisted).toMatchObject({
    imageWidth: 1,
    imageHeight: 1,
    uploaderAgentId: "a",
    uploaderId: null,
  });
  expect(result).not.toHaveProperty("imageWidth");
  expect(result).not.toHaveProperty("imageHeight");
});
