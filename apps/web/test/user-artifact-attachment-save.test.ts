import { expect, test } from "bun:test";
import { saveAttachmentAsArtifact } from "#src/server/artifacts/agent-artifact-save.server";
import { ARTIFACT_TEXT_LIMIT } from "#src/server/artifacts/artifact-files.server";
import { isAppError } from "#src/lib/app-error";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const CONV_ID = "33333333-3333-4333-8333-333333333333";
const MSG_ID = "44444444-4444-4444-8444-444444444444";
const ATT_ID = "55555555-5555-4555-8555-555555555555";
const ART_ID = "66666666-6666-4666-8666-666666666666";

test("saveAttachmentAsArtifact allows a human user to save a chat attachment as an artifact", async () => {
  const uploaded: unknown[] = [];
  const createdCalls: unknown[] = [];
  const result = await saveAttachmentAsArtifact(
    {
      db: {
        artifact: { findFirst: async () => null },
      } as never,
      documents: {
        cards: async () => [],
        create: async (scope, input) => {
          createdCalls.push({ scope, input });
          return { id: ART_ID, title: input.title } as never;
        },
      },
      blobs: {
        upload: async (input) => {
          uploaded.push(input);
          return { sha256: "abc123", sizeBytes: 5, kind: "text" } as never;
        },
      },
      attachments: {
        read: async (principal, attachmentId) => {
          expect(principal).toEqual({ workspaceId: WORKSPACE_ID, userId: USER_ID });
          expect(attachmentId).toBe(ATT_ID);
          return {
            id: ATT_ID,
            messageId: MSG_ID,
            conversationId: CONV_ID,
            fileName: "report.md",
            sizeBytes: 5,
            bytes: async () => new Uint8Array([104, 101, 108, 108, 111]),
          };
        },
      },
    },
    { workspaceId: WORKSPACE_ID, userId: USER_ID },
    ATT_ID,
  );

  expect(result).toEqual({
    artifact: { id: ART_ID, title: "report.md" } as never,
    created: true,
    attachment: { id: ATT_ID, fileName: "report.md" },
  });
  expect(uploaded).toHaveLength(1);
  expect(createdCalls).toHaveLength(1);
  expect(createdCalls[0]).toEqual({
    scope: { workspaceId: WORKSPACE_ID, actor: { userId: USER_ID } },
    input: {
      conversationId: CONV_ID,
      title: "report.md",
      manifest: { files: [{ path: "report.md", sha256: "abc123" }], entryPath: "report.md" },
      origin: { messageId: MSG_ID, attachmentId: ATT_ID },
    },
  });
});

test("saveAttachmentAsArtifact returns existing visible artifact without re-uploading", async () => {
  let uploadCalled = false;
  const result = await saveAttachmentAsArtifact(
    {
      db: {
        artifact: { findFirst: async () => ({ id: ART_ID }) },
      } as never,
      documents: {
        cards: async () => [{ id: ART_ID, title: "report.md" } as never],
        create: async () => {
          throw new Error("should not create");
        },
      },
      blobs: {
        upload: async () => {
          uploadCalled = true;
          throw new Error("should not upload");
        },
      },
      attachments: {
        read: async () => ({
          id: ATT_ID,
          messageId: MSG_ID,
          conversationId: CONV_ID,
          fileName: "report.md",
          sizeBytes: 5,
          bytes: async () => new Uint8Array(),
        }),
      },
    },
    { workspaceId: WORKSPACE_ID, userId: USER_ID },
    ATT_ID,
  );

  expect(uploadCalled).toBe(false);
  expect(result.created).toBe(false);
  expect(result.artifact.id).toBe(ART_ID);
});

test("saveAttachmentAsArtifact rejects oversized attachments and hidden existing artifacts", async () => {
  const oversized = saveAttachmentAsArtifact(
    {
      db: { artifact: { findFirst: async () => null } } as never,
      documents: { cards: async () => [], create: async () => ({}) as never },
      blobs: { upload: async () => ({}) as never },
      attachments: {
        read: async () => ({
          id: ATT_ID,
          messageId: MSG_ID,
          conversationId: CONV_ID,
          fileName: "huge.bin",
          sizeBytes: ARTIFACT_TEXT_LIMIT + 1,
          bytes: async () => new Uint8Array(),
        }),
      },
    },
    { workspaceId: WORKSPACE_ID, userId: USER_ID },
    ATT_ID,
  );
  let oversizedError: unknown;
  try {
    await oversized;
  } catch (err) {
    oversizedError = err;
  }
  expect(isAppError(oversizedError) && oversizedError.code === "INVALID_INPUT").toBe(true);

  let hiddenError: unknown;
  try {
    await saveAttachmentAsArtifact(
      {
        db: { artifact: { findFirst: async () => ({ id: ART_ID }) } } as never,
        documents: { cards: async () => [], create: async () => ({}) as never },
        blobs: { upload: async () => ({}) as never },
        attachments: {
          read: async () => ({
            id: ATT_ID,
            messageId: MSG_ID,
            conversationId: CONV_ID,
            fileName: "secret.md",
            sizeBytes: 10,
            bytes: async () => new Uint8Array(),
          }),
        },
      },
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      ATT_ID,
    );
  } catch (err) {
    hiddenError = err;
  }
  expect(isAppError(hiddenError) && hiddenError.code === "CONFLICT").toBe(true);
});
