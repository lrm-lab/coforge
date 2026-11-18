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
};
const uploading = { ...draft, uploading: true };

describe("a send pressed while a file is still uploading", () => {
  test("Enter waits for the upload and sends once it is in", () => {
    expect(composerSendPress(uploading)).toBe("after-uploads");
    expect(composerUploadsSettled({ waiting: true, uploading: true, anyFailed: false })).toBe(
      "waiting",
    );
    expect(composerUploadsSettled({ waiting: true, uploading: false, anyFailed: false })).toBe(
      "send",
    );
  });

  test("the Send button stays pressable and waits the same way", () => {
    expect(composerSendDisabled(uploading)).toBe(false);
    expect(composerSendPress(uploading)).toBe("after-uploads");
  });

  test("a failed upload cancels the waiting send and leaves Send to the person", () => {
    expect(composerSendPress(uploading)).toBe("after-uploads");
    expect(composerUploadsSettled({ waiting: true, uploading: false, anyFailed: true })).toBe(
      "cancel",
    );
    expect(composerSendDisabled({ ...draft, anyFailed: true })).toBe(true);
  });
});

describe("a send with nothing uploading", () => {
  test("goes out at once, and nothing is waiting afterwards", () => {
    expect(composerSendPress(draft)).toBe("now");
    expect(composerUploadsSettled({ waiting: false, uploading: false, anyFailed: false })).toBe(
      "idle",
    );
  });

  test("an empty draft or an unhydrated composer sends nothing", () => {
    expect(composerSendPress({ ...draft, hasContent: false })).toBe("ignored");
    expect(composerSendPress({ ...draft, hydrated: false })).toBe("ignored");
  });
});
