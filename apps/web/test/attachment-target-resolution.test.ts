import { expect, test } from "bun:test";

import { AppError } from "#src/lib/app-error";
import { handleAgentAttachmentUpload } from "#src/routes/api/agent/v1/attachments/index";
import { handleAttachmentUploadSessionCreate } from "#src/routes/api/agent/v1/attachment-upload-sessions/index";

// Both attachment routes (multipart upload and upload session) turn a target into the
// conversation that owns the attachment the same way: drop any `:thread` suffix, resolve it, and
// answer a resolution failure with one refusal contract. This pins that contract on both.

const principal = { workspaceId: "workspace-1", agentId: "agent-1" };

type Resolve = (
  workspaceId: string,
  agentId: string,
  target: string,
) => Promise<{ conversationId: string }>;

const routes = [
  {
    name: "multipart upload",
    call: (target: string, resolveTarget: Resolve) => {
      const form = new FormData();
      form.set("file", new Blob(["hello"], { type: "text/plain" }), "note.txt");
      form.set("target", target);
      return handleAgentAttachmentUpload(
        new Request("https://coforge.test/api/agent/v1/attachments", {
          method: "POST",
          body: form,
        }),
        principal,
        {
          resolveTarget,
          store: async () => ({
            id: "attachment-1",
            fileName: "note.txt",
            contentType: "text/plain",
            sizeBytes: 5,
          }),
        },
      );
    },
  },
  {
    name: "upload session",
    call: (target: string, resolveTarget: Resolve) =>
      handleAttachmentUploadSessionCreate(
        new Request("https://coforge.test/api/agent/v1/attachment-upload-sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            target,
            fileName: "note.txt",
            contentType: "text/plain",
            sizeBytes: 5,
            idempotencyKey: "11111111-1111-1111-1111-111111111111",
          }),
        }),
        principal,
        {
          resolveTarget,
          create: async () => ({
            uploadId: "upload-1",
            attachmentId: "attachment-1",
            state: "pending" as const,
            expiresAt: "2026-01-01T00:15:00.000Z",
            upload: { method: "PUT" as const, url: "https://oss.test/x", headers: {} },
          }),
        } as never,
      ),
  },
] as const;

const notAccessible = (status: number) => ({
  status,
  body: { error: "target is not accessible", code: "TARGET_NOT_ACCESSIBLE", retryable: false },
});

const refusals: [string, unknown, { status: number; body: unknown }][] = [
  ["a channel the Agent is not a member of", new AppError("ACCESS_DENIED"), notAccessible(403)],
  ["a malformed #channel", new AppError("INVALID_INPUT"), notAccessible(400)],
  ["a malformed @user grammar", new Error("invalid message target"), notAccessible(400)],
  ["an unknown @user", new Error("target user not found"), notAccessible(403)],
  [
    "a DM scope outside the Workspace",
    new Error("conversation scope is not authorized"),
    notAccessible(403),
  ],
  [
    "a direct message whose person left the Workspace",
    new AppError("DM_PEER_NOT_IN_WORKSPACE"),
    {
      status: 403,
      body: {
        error:
          "@ada is not a member of this Workspace, so this Agent cannot send them a direct message",
        code: "DM_PEER_NOT_IN_WORKSPACE",
        retryable: false,
      },
    },
  ],
];

for (const route of routes) {
  test(`${route.name}: the thread suffix is dropped before the target is resolved`, async () => {
    const resolved: string[] = [];
    const response = await route.call("#general:01a13467-8726", async (workspaceId, agentId, t) => {
      resolved.push(`${workspaceId}/${agentId}/${t}`);
      return { conversationId: "conversation-1" };
    });
    expect(response.ok).toBe(true);
    expect(resolved).toEqual(["workspace-1/agent-1/#general"]);
  });

  for (const [why, error, expected] of refusals)
    test(`${route.name}: ${why} is refused with the shared contract`, async () => {
      const response = await route.call("@ada:01a13467-8726", async () => {
        throw error;
      });
      expect({ status: response.status, body: await response.json() }).toEqual(expected);
    });
}

// `resolveTarget` is a method of the dependencies object; a caller may implement it with `this`.
test("both routes call resolveTarget as a method of their dependencies", async () => {
  const form = new FormData();
  form.set("file", new Blob(["hello"], { type: "text/plain" }), "note.txt");
  form.set("target", "#general");
  const upload = await handleAgentAttachmentUpload(
    new Request("https://coforge.test/api/agent/v1/attachments", { method: "POST", body: form }),
    principal,
    {
      conversationId: "conversation-1",
      async resolveTarget(this: { conversationId: string }) {
        return { conversationId: this.conversationId };
      },
      async store(input: { conversationId: string }) {
        expect(input.conversationId).toBe("conversation-1");
        return {
          id: "attachment-1",
          fileName: "note.txt",
          contentType: "text/plain",
          sizeBytes: 5,
        };
      },
    } as never,
  );
  expect(upload.status).toBe(200);

  const session = await handleAttachmentUploadSessionCreate(
    new Request("https://coforge.test/api/agent/v1/attachment-upload-sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        target: "#general",
        fileName: "note.txt",
        contentType: "text/plain",
        sizeBytes: 5,
        idempotencyKey: "11111111-1111-1111-1111-111111111111",
      }),
    }),
    principal,
    {
      conversationId: "conversation-1",
      async resolveTarget(this: { conversationId: string }) {
        return { conversationId: this.conversationId };
      },
      async create(input: { conversationId: string }) {
        expect(input.conversationId).toBe("conversation-1");
        return {
          uploadId: "upload-1",
          attachmentId: "attachment-1",
          state: "pending" as const,
          expiresAt: "2026-01-01T00:15:00.000Z",
          upload: { method: "PUT" as const, url: "https://oss.test/x", headers: {} },
        };
      },
    } as never,
  );
  expect(session.status).toBe(201);
});
