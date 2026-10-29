import { expect, test } from "bun:test";
import { ATTACHMENT_MAX_BYTES } from "@lrm/coforge-sdk/internal";

import {
  oversizedUpload,
  refusedUploadFailure,
  retryableUploadFailure,
} from "#src/features/conversations/upload-failure";

test("a file past the limit is refused when it is picked, one at the limit is sent", () => {
  expect(oversizedUpload({ size: ATTACHMENT_MAX_BYTES + 1 })).toBe("too_large");
  expect(oversizedUpload({ size: ATTACHMENT_MAX_BYTES })).toBeUndefined();
});

test("a refused upload names its reason from the answer's status", () => {
  // A proxy in front of the server answers 413 for the size too, without our body.
  expect(refusedUploadFailure(413)).toBe("too_large");
  expect(refusedUploadFailure(401)).toBe("signed_out");
  expect(refusedUploadFailure(403)).toBe("forbidden");
  expect(refusedUploadFailure(400)).toBe("failed");
  expect(refusedUploadFailure(503)).toBe("failed");
});

test("only a failure a retry may get past offers one", () => {
  expect(retryableUploadFailure("offline")).toBe(true);
  expect(retryableUploadFailure("failed")).toBe(true);
  expect(retryableUploadFailure("too_large")).toBe(false);
  expect(retryableUploadFailure("signed_out")).toBe(false);
  expect(retryableUploadFailure("forbidden")).toBe(false);
});
