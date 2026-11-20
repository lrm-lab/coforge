import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { MESSAGE_BODY_MAX_LENGTH } from "@lrm/coforge-sdk/internal";
import { CliError } from "#src/cli-error";
import { CLI_LONG_MESSAGE_NOTE } from "#src/long-message-attachment";
import { runMessageSend } from "#src/message-send-run";
import type { MessageTransport } from "#src/message-transport";
import { runTaskConversation } from "#src/task-conversation-run";

function makeMessageTransport(overrides: Partial<MessageTransport> = {}): MessageTransport {
  return {
    send: async () => ({ messageId: "msg-1", recentUnread: [] }),
    check: async () => ({ messages: [] }),
    read: async () => ({ messages: [] }),
    view: async () => ({ bytes: new Uint8Array() }),
    upload: async ({ path }) => {
      const content = await readFile(path, "utf8");
      return {
        id: "att-long-1",
        fileName: path.split("/").pop() ?? "message.md",
        contentType: "text/markdown",
        sizeBytes: Buffer.byteLength(content, "utf8"),
      };
    },
    ...overrides,
  };
}

describe("CLI long message auto-attachment (#42)", () => {
  test("message send at exact MESSAGE_BODY_MAX_LENGTH (8000) sends directly without uploading", async () => {
    const exact = "a".repeat(MESSAGE_BODY_MAX_LENGTH);
    let uploads = 0;
    let sentBody: string | undefined;
    let sentAttachments: string[] | undefined;
    const transport = makeMessageTransport({
      upload: async () => {
        uploads++;
        return { id: "att-1", fileName: "m.md", contentType: "text/markdown", sizeBytes: 1 };
      },
      send: async (_target, body, options) => {
        sentBody = body;
        sentAttachments = options?.attachmentIds;
        return { messageId: "msg-exact", recentUnread: [] };
      },
    });

    const out = String(
      await runMessageSend(
        { command: "send", target: "#general", sendDraft: false, json: false },
        transport,
        async () => exact,
      ),
    );
    expect(uploads).toBe(0);
    expect(sentBody).toBe(exact);
    expect(sentAttachments).toBeUndefined();
    expect(out).not.toContain("超长，已作为文件发送");
  });

  test("message send at 8001 chars uploads Markdown file, appends existing attachment-id, and prints notice", async () => {
    const over = `第一行预览\n${"b".repeat(MESSAGE_BODY_MAX_LENGTH)}`;
    let uploadedTarget: string | undefined;
    let uploadedMime: string | undefined;
    let uploadedName: string | undefined;
    let uploadedContent: string | undefined;
    let sentBody: string | undefined;
    let sentAttachments: string[] | undefined;
    const existingId = "11111111-1111-4111-8111-111111111111";

    const transport = makeMessageTransport({
      upload: async ({ path, target, mimeType }) => {
        uploadedTarget = target;
        uploadedMime = mimeType;
        uploadedName = path.split("/").pop();
        uploadedContent = await readFile(path, "utf8");
        return {
          id: "22222222-2222-4222-8222-222222222222",
          fileName: uploadedName!,
          contentType: "text/markdown",
          sizeBytes: Buffer.byteLength(uploadedContent, "utf8"),
        };
      },
      send: async (_target, body, options) => {
        sentBody = body;
        sentAttachments = options?.attachmentIds;
        return { messageId: "msg-long", recentUnread: [] };
      },
    });

    const out = String(
      await runMessageSend(
        {
          command: "send",
          target: "#general",
          sendDraft: false,
          attachmentIds: [existingId],
          json: false,
        },
        transport,
        async () => over,
      ),
    );
    expect(uploadedTarget).toBe("#general");
    expect(uploadedMime).toBe("text/markdown");
    expect(uploadedName).toMatch(/^message-\d{8}-\d{6}\.md$/);
    expect(uploadedContent).toBe(`${over}\n`);
    expect(sentBody).toContain(CLI_LONG_MESSAGE_NOTE);
    expect(sentAttachments).toEqual([existingId, "22222222-2222-4222-8222-222222222222"]);
    expect(out).toContain("超长，已作为文件发送");
    expect(out).toContain("22222222-2222-4222-8222-222222222222");
  });

  test("message send --send-draft does not re-upload after upload succeeded and send saved a draft", async () => {
    const over = "x".repeat(MESSAGE_BODY_MAX_LENGTH + 1);
    let uploads = 0;
    let draftAttachments: string[] | undefined;
    const transport = makeMessageTransport({
      upload: async () => {
        uploads++;
        return {
          id: "33333333-3333-4333-8333-333333333333",
          fileName: "message.md",
          contentType: "text/markdown",
          sizeBytes: over.length,
        };
      },
      send: async (_target, _body, options) => {
        if (!options?.sendDraft) {
          draftAttachments = options?.attachmentIds;
          throw new CliError({
            code: "SEND_FAILED",
            message: "network error",
            retryable: true,
            draftSaved: true,
          });
        }
        return { messageId: "msg-draft-resent", recentUnread: [] };
      },
    });

    await expect(
      runMessageSend(
        { command: "send", target: "#general", sendDraft: false, json: false },
        transport,
        async () => over,
      ),
    ).rejects.toThrow("network error");
    expect(uploads).toBe(1);
    expect(draftAttachments).toEqual(["33333333-3333-4333-8333-333333333333"]);

    const resent = String(
      await runMessageSend(
        { command: "send", target: "#general", sendDraft: true, json: false },
        transport,
        async () => "",
      ),
    );
    expect(uploads).toBe(1);
    expect(resent).toContain("msg-draft-resent");
  });

  test("task reply at 8000 sends directly, at 8001 uploads once even on retryable failure, and surfaces upload size error", async () => {
    const task = { ref: "#coforge-backend:#42", board: "coforge-backend", number: 42 };

    let uploads = 0;
    const exactOut = await runTaskConversation(
      {
        upload: async () => {
          uploads++;
          return { id: "unused", fileName: "m.md", contentType: "text/markdown", sizeBytes: 1 };
        },
        taskConversation: async () => ({
          messageId: "reply-1",
          sequence: 1,
        }),
      },
      { command: "task-conversation", op: "reply", task, json: false },
      async () => "k".repeat(MESSAGE_BODY_MAX_LENGTH),
    );
    expect(uploads).toBe(0);
    expect(exactOut).not.toContain("超长，已作为文件发送");

    let replyCalls = 0;
    let reconcileCalls = 0;
    const seenKeys: string[] = [];
    let seenAttachments: string[] | undefined;
    const existingId = "44444444-4444-4444-8444-444444444444";
    const uploadedId = "55555555-5555-4555-8555-555555555555";
    const retryOut = await runTaskConversation(
      {
        upload: async ({ target }) => {
          uploads++;
          expect(target).toBe("#coforge-backend:#42");
          return {
            id: uploadedId,
            fileName: "message.md",
            contentType: "text/markdown",
            sizeBytes: 8002,
          };
        },
        taskConversation: async (request) => {
          if (request.route === "reply" && request.body) {
            const body = request.body as {
              idempotencyKey: string;
              attachmentIds?: string[];
              reconcileOnly?: boolean;
            };
            if (body.reconcileOnly) {
              reconcileCalls++;
              expect(body.idempotencyKey).toBe(seenKeys[0]!);
              return { state: "not_found" };
            }
            replyCalls++;
            seenKeys.push(body.idempotencyKey);
            seenAttachments = body.attachmentIds;
          }
          if (replyCalls === 1) {
            throw new CliError({ code: "SERVER_ERROR", message: "503", retryable: true });
          }
          return { messageId: "reply-2", sequence: 2 };
        },
      },
      {
        command: "task-conversation",
        op: "reply",
        task,
        attachmentIds: [existingId],
        json: false,
      },
      async () => "k".repeat(MESSAGE_BODY_MAX_LENGTH + 1),
    );
    expect(uploads).toBe(1);
    expect(reconcileCalls).toBe(1);
    expect(replyCalls).toBe(2);
    expect(seenKeys[0]).toBe(seenKeys[1]);
    expect(seenAttachments).toEqual([existingId, uploadedId]);
    expect(retryOut).toContain("超长，已作为文件发送");
    expect(retryOut).toContain(uploadedId);

    let sentAfterLimitError = false;
    await expect(
      runTaskConversation(
        {
          upload: async () => {
            throw new CliError({
              code: "FILE_TOO_LARGE",
              message: "Attachment exceeds the 10 MB upload limit.",
              retryable: false,
            });
          },
          taskConversation: async () => {
            sentAfterLimitError = true;
            return {};
          },
        },
        { command: "task-conversation", op: "reply", task, json: false },
        async () => "z".repeat(60_000),
      ),
    ).rejects.toThrow("Attachment exceeds the 10 MB upload limit.");
    expect(sentAfterLimitError).toBe(false);
  });
});
