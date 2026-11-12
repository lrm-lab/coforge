import { expect, test } from "bun:test";
import { CliError } from "../src/cli-error";
import { parseArgs } from "../index";
import { runArtifact } from "../src/artifact-commands";
import { artifactTransport } from "../src/artifact-file-transport";
import {
  BINARY,
  CONTEXT,
  ID,
  failure,
  invoke,
  serveBytes,
  sha256,
  useScratch,
} from "./artifact-directory-fixture";

useScratch();

/** `coforge artifact` arguments, list and read, and the file transfers through the proxy. */

test("pull, push and download parse into their own commands", () => {
  expect(parseArgs(["artifact", "pull", ID, "--dir", "out", "--rev", "2"])).toEqual({
    command: "artifact",
    directory: { operation: "pull", artifact: ID, dir: "out", rev: 2 },
  });
  expect(parseArgs(["artifact", "pull", ID, "--json"])).toEqual({
    command: "artifact",
    directory: { operation: "pull", artifact: ID },
    json: true,
  });
  expect(
    parseArgs([
      "artifact",
      "push",
      "site",
      "--target",
      "#launch",
      "--title",
      "Site",
      "--description",
      "A page",
      "--entry",
      "index.html",
      "--note",
      "n",
      "--label",
      "l",
      "--delete",
      "a.css",
      "--delete",
      "b.css",
      "--include-hidden",
    ]),
  ).toEqual({
    command: "artifact",
    directory: {
      operation: "push",
      dir: "site",
      target: "#launch",
      title: "Site",
      description: "A page",
      entry: "index.html",
      note: "n",
      label: "l",
      delete: ["a.css", "b.css"],
      includeHidden: true,
    },
  });
  expect(parseArgs(["artifact", "push"])).toEqual({
    command: "artifact",
    directory: { operation: "push", dir: "." },
  });
  expect(
    parseArgs(["artifact", "download", ID, "css/site.css", "--output", "x", "--rev", "3"]),
  ).toEqual({
    command: "artifact",
    directory: { operation: "download", artifact: ID, path: "css/site.css", output: "x", rev: 3 },
  });
  // The older form, over one text file, keeps working.
  expect(parseArgs(["artifact", "push", ID, "--base", "3", "--file", "plan.md"])).toMatchObject({
    request: { operation: "push", artifact: ID, baseVersion: 3 },
  });
  expect(
    parseArgs(["artifact", "list", "--query", "launch plan", "--after", "c1", "--limit", "5"]),
  ).toEqual({
    command: "artifact",
    request: { operation: "list", query: "launch plan", after: "c1", limit: 5 },
  });
  expect(parseArgs(["artifact", "read", ID, "--files"])).toMatchObject({ allFiles: true });
  for (const args of [
    ["artifact", "pull"],
    ["artifact", "pull", ID, "--rev", "x"],
    ["artifact", "pull", ID, "extra"],
    ["artifact", "download", ID],
    ["artifact", "push", "a", "b"],
    ["artifact", "push", "--base", "2"],
    ["artifact", "push", "dir", "--delete"],
  ])
    expect(() => parseArgs(args)).toThrow(CliError);
});

test("list prints the cursor of the next page when there is one", async () => {
  const row = {
    id: ID,
    name: "n",
    title: "Plan",
    currentVersion: 2,
    updatedAt: "2026-11-04T02:00:00Z",
  };
  const said = (await runArtifact(invoke(["list", "--query", "plan"]), {
    artifact: async () => ({ artifacts: [row], nextCursor: "c2" }),
  })) as string;
  expect(said).toContain(`"Plan" (id ${ID}), version 2`);
  expect(said).toContain("coforge artifact list --query plan --after c2");
  const last = (await runArtifact(invoke(["list"]), {
    artifact: async () => ({ artifacts: [row] }),
  })) as string;
  expect(last).not.toContain("--after");
  expect(await runArtifact(invoke(["list"]), { artifact: async () => ({ artifacts: [] }) })).toBe(
    "No artifacts here yet.",
  );
});

test("read lists the version's files and its entry, a few unless asked for all", async () => {
  const files = Array.from({ length: 14 }, (_, index) => ({
    path: `f${String(index).padStart(2, "0")}.md`,
    sha256: sha256(String(index)),
    sizeBytes: 100 + index,
    kind: "text",
  }));
  const answer = {
    artifact: { id: ID, title: "Plan", currentVersion: 3 },
    version: { number: 3, label: null },
    entryPath: "f00.md",
    files,
    text: "body",
  };
  const some = (await runArtifact(invoke(["read", ID]), {
    artifact: async () => answer,
  })) as string;
  expect(some).toContain("Entry: f00.md");
  expect(some).toContain("Files (14):");
  expect(some).toContain("f09.md");
  expect(some).not.toContain("f10.md");
  expect(some).toContain("4 more");
  expect(some).toContain(`coforge artifact pull ${ID}`);
  const all = (await runArtifact(invoke(["read", ID, "--files"]), {
    artifact: async () => answer,
  })) as string;
  expect(all).toContain("f13.md");
  expect(all).not.toContain("more");
});

test("an artifact file goes up as raw bytes by its hash, and comes down exactly", async () => {
  const hash = sha256(BINARY);
  const proxy = serveBytes((request) =>
    request.method === "PUT"
      ? new Response(null, { status: 204 })
      : new Response(BINARY, { headers: { "content-type": "image/png" } }),
  );
  const files = artifactTransport(proxy.endpoint, CONTEXT, proxy.proxyUrl);
  await files.artifactUpload(hash, BINARY);
  const bytes = await files.artifactDownload({
    artifact: ID,
    path: "img/logo bin.png",
    version: 2,
  });
  expect(bytes).toEqual(BINARY);
  expect(proxy.seen[0]).toMatchObject({
    method: "PUT",
    path: `/api/agent/v1/artifacts/uploads/${hash}`,
  });
  expect(proxy.seen[0]!.bytes).toEqual(BINARY);
  expect(proxy.seen[0]!.headers.get("authorization")).toBe(`Bearer ${CONTEXT}`);
  expect(proxy.seen[1]).toMatchObject({
    method: "GET",
    path: `/api/agent/v1/artifacts/${ID}/files/img%2Flogo%20bin.png?version=2`,
  });
});

test("a refused file transfer keeps the server's reason", async () => {
  const refuse = (status: number, body: unknown) =>
    serveBytes(() => Response.json(body, { status }));
  const hash = sha256(BINARY);
  const tooLarge = refuse(413, {
    error: "payload too large (artifact-quota)",
    code: "INVALID_INPUT",
  });
  const upload = await failure(
    artifactTransport(tooLarge.endpoint, CONTEXT, tooLarge.proxyUrl).artifactUpload(hash, BINARY),
  );
  expect(upload.message).toContain("artifact-quota");
  expect(upload.retryable).toBe(false);
  const disabled = refuse(403, {
    error: "forbidden (artifacts-disabled): this Workspace has not enabled artifacts",
    code: "ACCESS_DENIED",
  });
  expect(
    (
      await failure(
        artifactTransport(disabled.endpoint, CONTEXT, disabled.proxyUrl).artifactDownload({
          artifact: ID,
          path: "a",
        }),
      )
    ).code,
  ).toBe("ARTIFACTS_DISABLED");
  const missing = serveBytes(() => new Response("not found", { status: 404 }));
  const gone = await failure(
    artifactTransport(missing.endpoint, CONTEXT, missing.proxyUrl).artifactDownload({
      artifact: ID,
      path: "a",
    }),
  );
  expect(gone.code).toBe("NOT_FOUND");
  // The server's own hint for a missing file says more than "does not exist", and is kept.
  const noFile = serveBytes(() =>
    Response.json(
      {
        error: "not found (artifact-file-not-found)",
        code: "NOT_FOUND",
        retryable: false,
        suggested_next_action: "the version has no such file",
      },
      { status: 404 },
    ),
  );
  const missingFile = await failure(
    artifactTransport(noFile.endpoint, CONTEXT, noFile.proxyUrl).artifactDownload({
      artifact: ID,
      path: "a",
    }),
  );
  expect(missingFile.suggestedNextAction).toBe("the version has no such file");
  const unreachable = await failure(
    artifactTransport(
      () => new URL("http://127.0.0.1:1/x"),
      CONTEXT,
      "http://127.0.0.1:1",
    ).artifactUpload(hash, BINARY),
  );
  // Uploading the same bytes again changes nothing, so a failure on the way may be tried again.
  expect(unreachable.retryable).toBe(true);
});
