import { describe, expect, test } from "bun:test";
import {
  composerSendDisabled,
  composerSendPress,
  composerUploadsSettled,
  type ComposerSendState,
} from "#src/features/conversations/composer-send-gate";

const draft: ComposerSendState = {
  hydrated: true,
  uploading: false,
  anyFailed: false,
  hasContent: true,
  waiting: false,
};
const uploading: ComposerSendState = { ...draft, uploading: true };

describe("a send pressed while a file is still uploading", () => {
  test("Enter waits for the upload and sends once it is in", () => {
    expect(composerSendPress(uploading)).toBe("after-uploads");
    expect(
      composerUploadsSettled({
        waitingDraftKey: "channel:a",
        draftKey: "channel:a",
        uploading: true,
        anyFailed: false,
      }),
    ).toBe("waiting");
    expect(
      composerUploadsSettled({
        waitingDraftKey: "channel:a",
        draftKey: "channel:a",
        uploading: false,
        anyFailed: false,
      }),
    ).toBe("send");
  });

  test("the Send button stays pressable during upload and disables once waiting", () => {
    expect(composerSendDisabled(uploading)).toBe(false);
    expect(composerSendPress(uploading)).toBe("after-uploads");
    expect(composerSendDisabled({ ...uploading, waiting: true })).toBe(true);
  });

  test("a duplicate trigger while already waiting is ignored so the message sends once", () => {
    expect(composerSendPress({ ...uploading, waiting: true })).toBe("ignored");
    expect(
      composerUploadsSettled({
        waitingDraftKey: "channel:a",
        draftKey: "channel:a",
        uploading: true,
        anyFailed: false,
      }),
    ).toBe("waiting");
    expect(
      composerUploadsSettled({
        waitingDraftKey: "channel:a",
        draftKey: "channel:a",
        uploading: false,
        anyFailed: false,
      }),
    ).toBe("send");
  });

  test("a failed upload cancels immediately even while another attachment is still uploading", () => {
    expect(composerSendPress(uploading)).toBe("after-uploads");
    expect(
      composerUploadsSettled({
        waitingDraftKey: "channel:a",
        draftKey: "channel:a",
        uploading: true,
        anyFailed: true,
      }),
    ).toBe("cancel");
    expect(
      composerUploadsSettled({
        waitingDraftKey: "channel:a",
        draftKey: "channel:a",
        uploading: false,
        anyFailed: true,
      }),
    ).toBe("cancel");
    expect(composerSendDisabled({ ...draft, anyFailed: true })).toBe(true);
  });

  test("switching to another draft cancels the queued send instead of firing in the new conversation", () => {
    expect(
      composerUploadsSettled({
        waitingDraftKey: "channel:a",
        draftKey: "channel:b",
        uploading: false,
        anyFailed: false,
      }),
    ).toBe("cancel");
  });
});

describe("a send with nothing uploading", () => {
  test("goes out at once, and nothing is waiting afterwards", () => {
    expect(composerSendPress(draft)).toBe("now");
    expect(
      composerUploadsSettled({
        waitingDraftKey: null,
        draftKey: "channel:a",
        uploading: false,
        anyFailed: false,
      }),
    ).toBe("idle");
  });

  test("an empty draft or an unhydrated composer sends nothing", () => {
    expect(composerSendPress({ ...draft, hasContent: false })).toBe("ignored");
    expect(composerSendPress({ ...draft, hydrated: false })).toBe("ignored");
  });
});
