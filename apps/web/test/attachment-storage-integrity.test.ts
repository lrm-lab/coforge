import { expect, test } from "bun:test";
import { readAuthorizedAttachment } from "#src/server/attachments/attachment.server";

function fakeStorage(
  open: () => Promise<{ body: Blob; contentType: string | null; sizeBytes: number }>,
  head: () => Promise<{ sizeBytes: number; contentType: string | null } | null>,
) {
  return async () => ({ put: async () => {}, remove: async () => {}, head, open });
}

function attachmentDb() {
  return {
    attachment: {
      findUnique: async () => ({
        id: "attachment-1",
        conversationId: "conversation-1",
        messageId: "message-1",
        uploaderId: null,
        uploaderAgentId: "agent-1",
        objectKey: "workspaces/w/attachments/attachment-1/original",
        fileName: "note.txt",
        contentType: "text/plain",
        sizeBytes: 5,
      }),
    },
    conversationMember: { findFirst: async () => ({ id: "member-1" }) },
  };
}

test("attachment reads check object presence before opening its stream", async () => {
  let opened = false;
  const result = await readAuthorizedAttachment(
    attachmentDb() as never,
    { attachmentId: "attachment-1", agentId: "agent-1" },
    fakeStorage(
      async () => {
        opened = true;
        throw new Error("must not open a missing object");
      },
      async () => null,
    ),
  );
  await expect(result.open()).resolves.toBeNull();
  expect(opened).toBe(false);
});

test("attachment reads reject a stored object whose size changed", async () => {
  const result = await readAuthorizedAttachment(
    attachmentDb() as never,
    { attachmentId: "attachment-1", agentId: "agent-1" },
    fakeStorage(
      async () => ({ body: new Blob(["wrong"]), contentType: null, sizeBytes: 4 }),
      async () => ({ sizeBytes: 4, contentType: "text/plain" }),
    ),
  );
  await expect(result.open()).rejects.toThrow("stored attachment size mismatch");
});
