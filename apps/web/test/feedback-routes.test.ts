import { describe, expect, it } from "bun:test";

import { AppError } from "#src/lib/app-error";
import { handleFeedbackSubmit } from "#src/routes/api/feedback";
import { handleFeedbackAttachmentDownload } from "#src/routes/api/feedback.attachments.$attachmentId";

const VALID_UUID = "0194b4a8-1a2b-7c3d-8e4f-5a6b7c8d9e0f";

describe("feedback HTTP routes", () => {
  it("returns 401 for unauthenticated feedback submission", async () => {
    const response = await handleFeedbackSubmit(
      new Request("http://localhost/api/feedback", { method: "POST" }),
      {
        authenticate: () => {
          throw new AppError("ACCESS_DENIED");
        },
        database: () => ({}) as never,
        submit: async () => ({ id: "fb-1", createdAt: "2026-11-26T09:00:00.000Z" }),
      },
    );
    expect(response.status).toBe(401);
  });

  it("validates FormData fields and returns 201 on success", async () => {
    const form = new FormData();
    form.set("category", "idea");
    form.set("body", "Support dark mode screenshots");
    form.set("workspaceId", VALID_UUID);
    form.set("pagePath", "/w/coforge");

    let capturedBody = "";
    const response = await handleFeedbackSubmit(
      new Request("http://localhost/api/feedback", { method: "POST", body: form }),
      {
        authenticate: () => ({ id: "user-1" }),
        database: () => ({}) as never,
        submit: async (_db, input) => {
          capturedBody = input.body;
          return { id: "fb-1", createdAt: "2026-11-26T09:00:00.000Z" };
        },
      },
    );
    expect(response.status).toBe(201);
    expect(capturedBody).toBe("Support dark mode screenshots");

    const invalidForm = new FormData();
    invalidForm.set("category", "idea");
    invalidForm.set("body", "   ");
    const bad = await handleFeedbackSubmit(
      new Request("http://localhost/api/feedback", { method: "POST", body: invalidForm }),
      {
        authenticate: () => ({ id: "user-1" }),
        database: () => ({}) as never,
        submit: async () => ({ id: "fb-2", createdAt: "2026-11-26T09:00:00.000Z" }),
      },
    );
    expect(bad.status).toBe(400);
  });

  it("streams private image bytes with nosniff and inline headers", async () => {
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const response = await handleFeedbackAttachmentDownload(
      new Request(`http://localhost/api/feedback/attachments/${VALID_UUID}`),
      { attachmentId: VALID_UUID },
      {
        authenticate: () => ({ id: "user-1" }),
        database: () => ({}) as never,
        read: async () => ({
          attachment: {
            fileName: "shot.png",
            contentType: "image/png",
            objectKey: "feedback/k1/original",
          },
          open: async () => ({
            body: new Blob([pngBytes], { type: "image/png" }),
            contentType: "image/png",
            sizeBytes: pngBytes.length,
          }),
        }),
        delivery: () => null,
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-disposition")).toBe("inline");

    const invalidId = await handleFeedbackAttachmentDownload(
      new Request("http://localhost/api/feedback/attachments/not-a-uuid"),
      { attachmentId: "not-a-uuid" },
      {
        authenticate: () => ({ id: "user-1" }),
        database: () => ({}) as never,
        read: async () => {
          throw new Error("should not be called");
        },
        delivery: () => null,
      },
    );
    expect(invalidId.status).toBe(404);
  });
});
