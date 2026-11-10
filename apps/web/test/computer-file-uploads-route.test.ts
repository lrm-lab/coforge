import { expect, test } from "bun:test";

import {
  handleComputerFileUpload,
  type ComputerFileUploadRouteDependencies,
} from "#src/routes/api/computers/$computerId/file-uploads";
import type { ComputerFileUploadStart } from "#src/server/computers/computer-file-upload.server";

/**
 * The upload route answers as soon as the body is received and validated: an upload id to read
 * the outcome with, or the reason it was refused. It never waits for the Computer.
 */
const COMPUTER = "0199f0c4-6d6a-7000-8000-000000000002";

function dependencies(
  start: ComputerFileUploadStart = { status: "started", uploadId: "up-1" },
  overrides: Partial<ComputerFileUploadRouteDependencies> = {},
): ComputerFileUploadRouteDependencies & { started: File[] } {
  const started: File[] = [];
  return {
    started,
    authenticate: async () => ({ id: "user-1" }),
    database: () => ({}) as never,
    resolveWorkspace: async () => "ws-1",
    start: async (_db, viewer, computerId, file) => {
      expect([viewer, computerId]).toEqual([{ userId: "user-1", workspaceId: "ws-1" }, COMPUTER]);
      started.push(file);
      return start;
    },
    ...overrides,
  };
}

function upload(file: File | string = new File(["hello"], "notes.txt")) {
  const form = new FormData();
  form.set("file", file);
  form.set("workspaceSlug", "acme");
  return new Request(`https://coforge.test/api/computers/${COMPUTER}/file-uploads`, {
    method: "POST",
    body: form,
  });
}

test("a valid upload is answered at once with its upload id", async () => {
  const deps = dependencies();
  const response = await handleComputerFileUpload(upload(), COMPUTER, deps);
  expect(response.status).toBe(202);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ status: "started", uploadId: "up-1" });
  expect(deps.started).toHaveLength(1);
  expect(deps.started[0]!.name).toBe("notes.txt");
});

test.each([
  ["too_large", 413],
  ["invalid_name", 400],
  ["storage_unavailable", 503],
  ["offline", 503],
  ["unsupported", 503],
  ["unavailable", 404],
] as const)(
  "a refused start (%s) answers %i with the reason the panel shows",
  async (reason, status) => {
    const response = await handleComputerFileUpload(
      upload(),
      COMPUTER,
      dependencies({ status: reason }),
    );
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ reason });
  },
);

test("a signed-out request or a file that is not one starts nothing", async () => {
  const signedOut = dependencies(undefined, { authenticate: async () => null });
  const refused = await handleComputerFileUpload(upload(), COMPUTER, signedOut);
  expect(refused.status).toBe(401);
  expect(await refused.json()).toEqual({ reason: "signed_out" });
  expect(signedOut.started).toHaveLength(0);

  const notAFile = dependencies();
  expect((await handleComputerFileUpload(upload("text"), COMPUTER, notAFile)).status).toBe(400);
  expect((await handleComputerFileUpload(upload(), "nope", notAFile)).status).toBe(400);
  expect(notAFile.started).toHaveLength(0);
});
