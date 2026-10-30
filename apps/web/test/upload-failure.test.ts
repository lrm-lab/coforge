import { expect, test } from "bun:test";
import { ATTACHMENT_MAX_BYTES } from "@lrm/coforge-sdk/internal";

import {
  cannotAttach,
  pickedFileFailures,
  refusedUploadFailure,
  retryableUploadFailure,
} from "#src/features/conversations/upload-failure";

test("a file past the limit is refused when it is picked, one at the limit is sent", () => {
  expect(pickedFileFailures([{ size: ATTACHMENT_MAX_BYTES + 1 }], 10)).toEqual(["too_large"]);
  expect(pickedFileFailures([{ size: ATTACHMENT_MAX_BYTES }], 10)).toEqual([undefined]);
});

test("an empty file is refused, and files past the room are too many, as Raft sorts a pick", () => {
  const big = { size: ATTACHMENT_MAX_BYTES + 1 };
  // Two places left: the empty and the oversized file take none of them.
  expect(pickedFileFailures([{ size: 0 }, { size: 1 }, big, { size: 2 }, { size: 3 }], 2)).toEqual([
    "empty",
    undefined,
    "too_large",
    undefined,
    "too_many",
  ]);
  expect(pickedFileFailures([{ size: 1 }], 0)).toEqual(["too_many"]);
  expect(pickedFileFailures([{ size: 1 }], -1)).toEqual(["too_many"]);
});

test("a file no retry can attach takes no place; one a retry may still attach does", () => {
  for (const failure of ["empty", "too_large", "too_many", "signed_out", "forbidden"] as const)
    expect(cannotAttach(failure)).toBe(true);
  for (const failure of ["offline", "failed", undefined] as const)
    expect(cannotAttach(failure)).toBe(false);
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
  expect(retryableUploadFailure("too_many")).toBe(false);
  expect(retryableUploadFailure("empty")).toBe(false);
  expect(retryableUploadFailure("signed_out")).toBe(false);
  expect(retryableUploadFailure("forbidden")).toBe(false);
});
