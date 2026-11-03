import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pullComputerFile } from "#src/computer-files/computer-file-pull";
import type { ComputerFilePullRequest } from "@lrm/coforge-sdk/internal";

const request: ComputerFilePullRequest = {
  protocolMajor: 1,
  requestId: "req-1",
  workspaceId: "ws-1",
  computerId: "pc-1",
  downloadUrl: "https://files.example/object",
  fileName: "hello.txt",
  sizeBytes: 5,
  contentType: "text/plain",
};

test("pulls bytes into workspaceRoot/uploads", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-file-pull-"));
  try {
    const result = await pullComputerFile(request, {
      workspaceRoot: root,
      fetch: async () =>
        new Response(new Uint8Array([104, 101, 108, 108, 111]), {
          status: 200,
          headers: { "content-length": "5" },
        }),
    });
    expect(result.status).toBe("ok");
    expect(result.path).toBe(join(root, "uploads", "hello.txt"));
    expect(await readFile(result.path, "utf8")).toBe("hello");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses a download larger than declared", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-file-pull-"));
  try {
    const result = await pullComputerFile(request, {
      workspaceRoot: root,
      fetch: async () =>
        new Response(new Uint8Array([1, 2, 3, 4, 5, 6]), {
          status: 200,
          headers: { "content-length": "6" },
        }),
    });
    expect(result.status).toBe("error");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
