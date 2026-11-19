import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";

import { isAppErrorCode } from "#src/lib/app-error";
import { createOssFileStorage } from "#src/server/files/oss-file-storage.server";
import type { ManagedFileStorage } from "#src/server/files/file-storage.server";
import { WorkspaceFileCleanup } from "#src/server/workspaces/file-cleanup.server";

let answer: { status: number; code: string } = { status: 403, code: "UserDisable" };
let server: ReturnType<typeof Bun.serve>;
let storage: ManagedFileStorage;

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${answer.code}</Code><Message>account detail</Message><RequestId>r</RequestId></Error>`;
      return new Response(xml, {
        status: answer.status,
        headers: {
          "content-type": "application/xml",
          "x-oss-request-id": "r",
          "x-oss-err": Buffer.from(xml).toString("base64"),
        },
      });
    },
  });
  storage = await createOssFileStorage({
    kind: "oss",
    bucket: "coforge-files-test",
    region: "cn-beijing",
    endpoint: `http://127.0.0.1:${server.port}`,
    internal: false,
    accessKey: { accessKeyId: "AKID", accessKeySecret: "SECRET" },
  });
});
afterAll(() => server.stop(true));
afterEach(() => {
  answer = { status: 403, code: "UserDisable" };
});

function captureWarnings() {
  const warn = spyOn(console, "warn").mockImplementation(() => undefined);
  return {
    events: () =>
      warn.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, string>),
    restore: () => warn.mockRestore(),
  };
}

test("an account-level storage error becomes a temporary-unavailable error and one alertable event", async () => {
  const logs = captureWarnings();
  try {
    const failure = await storage
      .put("workspaces/w/attachments/a/original", new Blob(["x"]), "text/plain")
      .catch((error: unknown) => error);
    expect(isAppErrorCode(failure, "TEMPORARILY_UNAVAILABLE")).toBe(true);
    expect(logs.events()).toEqual([
      { event: "object_storage:unavailable", error_name: "UserDisable", operation: "put" },
    ]);
  } finally {
    logs.restore();
  }
});

test.each(["UserDisable", "AccessDenied", "InvalidAccessKeyId", "SecurityTokenExpired"])(
  "%s is an account-level error on every operation that calls OSS",
  async (code) => {
    answer = { status: 403, code };
    const logs = captureWarnings();
    try {
      const attempts: Array<() => Promise<unknown> | undefined> = [
        () => storage.open("k"),
        () => storage.head?.("k"),
        () => storage.remove("k"),
        () => storage.removeMany?.(["k"]),
      ];
      for (const attempt of attempts) {
        const failure = await (async () => attempt())().catch((error: unknown) => error);
        expect(isAppErrorCode(failure, "TEMPORARILY_UNAVAILABLE")).toBe(true);
      }
      expect(logs.events().map((event) => event.error_name)).toEqual([code, code, code, code]);
    } finally {
      logs.restore();
    }
  },
);

test("other storage errors keep their own failure and log nothing", async () => {
  answer = { status: 500, code: "InternalError" };
  const logs = captureWarnings();
  try {
    const failure = await storage.remove("k").catch((error: unknown) => error);
    expect(isAppErrorCode(failure, "TEMPORARILY_UNAVAILABLE")).toBe(false);
    expect(failure).toBeInstanceOf(Error);
    expect(logs.events()).toEqual([]);
  } finally {
    logs.restore();
  }
});

test("a missing object is still absent, not unavailable", async () => {
  answer = { status: 404, code: "NoSuchKey" };
  expect(await storage.open("k")).toBeNull();
});

test("workspace file cleanup still only logs when the account is disabled", async () => {
  const logs = captureWarnings();
  try {
    const cleanup = new WorkspaceFileCleanup(
      { files: async () => storage as never, images: async () => storage as never },
      () => undefined,
    );
    await cleanup.remove("w", { files: ["workspaces/w/attachments/a/original"], images: [] });
    const failed = logs.events().filter((event) => event.event === "workspace_file_cleanup:failed");
    expect(failed.length).toBeGreaterThan(0);
  } finally {
    logs.restore();
  }
});
