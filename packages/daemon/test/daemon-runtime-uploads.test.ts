import { describe, expect, test } from "bun:test";
import type { AgentRuntimeConfig } from "@lrm/coforge-anvil";
import type { WorkspaceConfig } from "#src/daemon-runtime/runtime";
import { createMessageHarness } from "./fixtures/message-harness";

const connection: WorkspaceConfig = {
  computerId: "c",
  workspaceId: "w",
  workspaceRoot: "/tmp/coforge-uploads-runtime",
};
const config: AgentRuntimeConfig = {
  provider: "pi",
  model: "default",
  modelProvider: "anthropic",
  reasoning: "balanced",
};
const messageHarness = createMessageHarness({ connection, config });

describe("Agent attachment upload", () => {
  test("authorizes the local context before delegating the multipart request to the transport", async () => {
    const calls: Array<{ agentApiKey: string | undefined }> = [];
    const uploadResponse = Response.json({
      id: "attachment-1",
      fileName: "note.txt",
      contentType: "text/plain",
      sizeBytes: 4,
    });
    const harness = await messageHarness(
      async (request) => ({
        protocolMajor: 1,
        idempotencyKey: request.idempotencyKey,
        accepted: true,
        attentionCount: 0,
        messages: [],
      }),
      undefined,
      async (_request, agentApiKey) => {
        calls.push({ agentApiKey });
        return uploadResponse;
      },
    );
    try {
      const request = new Request("http://local-proxy.test/api/agent/v1/attachments", {
        method: "POST",
        headers: { "content-type": "multipart/form-data; boundary=b" },
        body: "irrelevant",
      });
      const response = await harness.runtime.agentRequests.agentAttachmentUpload(
        harness.context,
        request,
        harness.apiKey,
      );
      expect(response).toBe(uploadResponse);
      expect(calls).toEqual([{ agentApiKey: harness.apiKey }]);
    } finally {
      await harness.runtime.stop();
    }
  });

  test("rejects an upload from an unrecognized local context before touching the transport", async () => {
    let calls = 0;
    const harness = await messageHarness(
      async (request) => ({
        protocolMajor: 1,
        idempotencyKey: request.idempotencyKey,
        accepted: true,
        attentionCount: 0,
        messages: [],
      }),
      undefined,
      async () => {
        calls++;
        throw new Error("must not forward an unauthorized upload");
      },
    );
    try {
      const request = new Request("http://local-proxy.test/api/agent/v1/attachments", {
        method: "POST",
        headers: { "content-type": "multipart/form-data; boundary=b" },
        body: "irrelevant",
      });
      await expect(
        harness.runtime.agentRequests.agentAttachmentUpload(
          "forged-context",
          request,
          harness.apiKey,
        ),
      ).rejects.toThrow();
      expect(calls).toBe(0);
    } finally {
      await harness.runtime.stop();
    }
  });
});

describe("Agent direct-upload sessions", () => {
  test("authorizes the local context before delegating each session operation to the transport", async () => {
    const calls: Array<{ op: string; arg: unknown; agentApiKey: string | undefined }> = [];
    const createResponse = Response.json({ uploadId: "upload-1" }, { status: 201 });
    const completeResponse = Response.json({ uploadId: "upload-1", state: "completed" });
    const cancelResponse = Response.json({ uploadId: "upload-1", state: "canceled" });
    const getResponse = Response.json({ uploadId: "upload-1", state: "pending" });
    const harness = await messageHarness(
      async (request) => ({
        protocolMajor: 1,
        idempotencyKey: request.idempotencyKey,
        accepted: true,
        attentionCount: 0,
        messages: [],
      }),
      undefined,
      undefined,
      {
        create: async (body, agentApiKey) => {
          calls.push({ op: "create", arg: body, agentApiKey });
          return createResponse;
        },
        complete: async (uploadId, agentApiKey) => {
          calls.push({ op: "complete", arg: uploadId, agentApiKey });
          return completeResponse;
        },
        cancel: async (uploadId, agentApiKey) => {
          calls.push({ op: "cancel", arg: uploadId, agentApiKey });
          return cancelResponse;
        },
        get: async (uploadId, agentApiKey) => {
          calls.push({ op: "get", arg: uploadId, agentApiKey });
          return getResponse;
        },
      },
    );
    try {
      expect(
        await harness.runtime.agentRequests.agentAttachmentUploadSessionCreate(
          harness.context,
          { target: "#general" },
          harness.apiKey,
        ),
      ).toBe(createResponse);
      expect(
        await harness.runtime.agentRequests.agentAttachmentUploadSessionComplete(
          harness.context,
          "upload-1",
          harness.apiKey,
        ),
      ).toBe(completeResponse);
      expect(
        await harness.runtime.agentRequests.agentAttachmentUploadSessionCancel(
          harness.context,
          "upload-1",
          harness.apiKey,
        ),
      ).toBe(cancelResponse);
      expect(
        await harness.runtime.agentRequests.agentAttachmentUploadSessionGet(
          harness.context,
          "upload-1",
          harness.apiKey,
        ),
      ).toBe(getResponse);
      expect(calls).toEqual([
        { op: "create", arg: { target: "#general" }, agentApiKey: harness.apiKey },
        { op: "complete", arg: "upload-1", agentApiKey: harness.apiKey },
        { op: "cancel", arg: "upload-1", agentApiKey: harness.apiKey },
        { op: "get", arg: "upload-1", agentApiKey: harness.apiKey },
      ]);
    } finally {
      await harness.runtime.stop();
    }
  });

  test("rejects a session operation from an unrecognized local context before touching the transport", async () => {
    let calls = 0;
    const harness = await messageHarness(
      async (request) => ({
        protocolMajor: 1,
        idempotencyKey: request.idempotencyKey,
        accepted: true,
        attentionCount: 0,
        messages: [],
      }),
      undefined,
      undefined,
      {
        create: async () => {
          calls++;
          throw new Error("must not forward an unauthorized create");
        },
      },
    );
    try {
      await expect(
        harness.runtime.agentRequests.agentAttachmentUploadSessionCreate(
          "forged-context",
          { target: "#general" },
          harness.apiKey,
        ),
      ).rejects.toThrow();
      expect(calls).toBe(0);
    } finally {
      await harness.runtime.stop();
    }
  });
});
