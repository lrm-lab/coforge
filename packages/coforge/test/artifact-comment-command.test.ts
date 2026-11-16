import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import type { AgentArtifactRequest } from "@lrm/coforge-sdk/agent";
import { parseArgs, run, type MessageTransport } from "../index";
import { artifactRequest, runArtifact } from "../src/artifact-commands";
import { CliError } from "../src/cli-error";
import {
  C1,
  C2,
  C3,
  ID,
  REVIEW,
  comment,
  invocation,
  transportAnswering,
} from "./artifact-comment-fixture";

/** `coforge artifact comments|comment|review|resolve|reopen`: parsing, the text sent, the failures
 * of a call. How the answers print is `artifact-comment-format.test.ts`. */

const servers: { stop(): void }[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
});

test("comments parses its filters, and a comment id may carry the c_ it was printed with", () => {
  expect(invocation(["comments", ID])).toEqual({
    command: "artifact",
    comment: { operation: "comments", artifact: ID },
  });
  expect(
    invocation([
      "comments",
      ID,
      "--path",
      "plan.md",
      "--all",
      "--review",
      REVIEW,
      "--after",
      "x|y",
      "--json",
    ]),
  ).toEqual({
    command: "artifact",
    comment: {
      operation: "comments",
      artifact: ID,
      path: "plan.md",
      all: true,
      review: REVIEW,
      after: "x|y",
    },
    json: true,
  });
  expect(invocation(["resolve", ID, `c_${C1}`, "--note", "Fixed."])).toEqual({
    command: "artifact",
    comment: { operation: "resolve", artifact: ID, comment: C1, note: "Fixed." },
  });
  expect(invocation(["resolve", ID, C1])).toMatchObject({ comment: { comment: C1 } });
  expect(invocation(["reopen", ID, `c_${C1}`])).toEqual({
    command: "artifact",
    comment: { operation: "reopen", artifact: ID, comment: C1 },
  });
});

test("comment parses where it points: a file, a line or lines, a thread, a version", () => {
  expect(invocation(["comment", ID])).toEqual({
    command: "artifact",
    comment: { operation: "comment", artifact: ID },
  });
  expect(invocation(["comment", ID, "--path", "plan.md", "--lines", "7"])).toMatchObject({
    comment: { path: "plan.md", anchor: { type: "lines", data: { start: 7, end: 7 } } },
  });
  expect(
    invocation(["comment", ID, "--path", "plan.md", "--lines", "3-5", "--rev", "2"]),
  ).toMatchObject({
    comment: {
      path: "plan.md",
      anchor: { type: "lines", data: { start: 3, end: 5 } },
      version: 2,
    },
  });
  expect(invocation(["comment", ID, "--reply-to", `c_${C2}`])).toMatchObject({
    comment: { replyTo: C2 },
  });
  // A reply inherits its comment's file, so a line needs no --path beside --reply-to.
  expect(invocation(["comment", ID, "--reply-to", C2, "--lines", "2"])).toMatchObject({
    comment: { replyTo: C2, anchor: { type: "lines", data: { start: 2, end: 2 } } },
  });
});

test("a comment command that cannot be sent is refused with what to change", () => {
  for (const [args, said] of [
    [["comment", ID, "--path", "a.md", "--lines", "a-b"], "--lines takes a line N or a range a-b"],
    [["comment", ID, "--path", "a.md", "--lines", "3-"], "--lines takes a line N or a range a-b"],
    [["comment", ID, "--line", "3"], "Unexpected argument --line"],
    [["comment", ID, "--rev", "x"], '--rev takes a whole number, not "x"'],
    [["resolve", ID], "Name the comment"],
    [["reopen", ID, C1, "--note", "x"], "Unexpected argument --note"],
    [["comments"], "Name the artifact"],
    [["comment", ID, "--bogus"], "Unexpected argument --bogus"],
    [["comment", ID, "extra"], "Unexpected argument extra"],
    [["comment", ID, "--path", "a.md", "--path", "b.md"], "--path is given twice"],
  ] as const)
    expect(() => parseArgs(["artifact", ...args]), args.join(" ")).toThrow(said);
});

test("what the server judges is sent as typed: ids, a line past the file, a version", () => {
  // The server refuses these with the field named; the CLI does not guess at them.
  expect(invocation(["comment", ID, "--reply-to", "nonsense"])).toMatchObject({
    comment: { replyTo: "nonsense" },
  });
  expect(invocation(["comments", ID, "--review", "Nonsense"])).toMatchObject({
    comment: { review: "Nonsense" },
  });
  expect(invocation(["comment", ID, "--path", "a.md", "--lines", "5-3"])).toMatchObject({
    comment: { anchor: { type: "lines", data: { start: 5, end: 3 } } },
  });
  expect(invocation(["comment", ID, "--rev", "0"])).toMatchObject({ comment: { version: 0 } });
});

test("comment sends the body read from stdin, trimmed, with a fresh idempotency key", async () => {
  const answer = comment(C1);
  const { sent, transport } = transportAnswering(answer);
  const said = (await runArtifact(
    invocation(["comment", ID, "--path", "plan.md", "--lines", "3-4"]),
    transport,
    async () => "\n  Why three lines?\nSecond line.\n\n",
  )) as string;
  expect(sent[0]).toMatchObject({
    operation: "comment",
    artifact: ID,
    body: "Why three lines?\nSecond line.",
    path: "plan.md",
    anchor: { type: "lines", data: { start: 3, end: 4 } },
  });
  expect(typeof (sent[0] as { idempotencyKey: string }).idempotencyKey).toBe("string");
  expect(said).toContain(`Posted c_${C1} on plan.md:3-4 (version 2).`);
  const again = await runArtifact(invocation(["comment", ID]), transport, async () => "x");
  expect((sent[1] as { idempotencyKey: string }).idempotencyKey).not.toBe(
    (sent[0] as { idempotencyKey: string }).idempotencyKey,
  );
  expect(again).toContain("Posted c_");
  // --json prints the server's answer as it is.
  expect(
    await runArtifact(invocation(["comment", ID, "--json"]), transport, async () => "x"),
  ).toEqual(answer);
});

test("a comment with nothing on stdin is refused before anything is sent", async () => {
  const { sent, transport } = transportAnswering({});
  const error = (await runArtifact(invocation(["comment", ID]), transport, async () => " \n").catch(
    (caught: unknown) => caught,
  )) as CliError;
  expect(error).toBeInstanceOf(CliError);
  expect(error.message).toContain("Write the comment on stdin");
  expect(sent).toEqual([]);
});

test("review takes its comments as JSON on stdin, an object or a bare array", async () => {
  const answer = {
    review: {
      id: REVIEW,
      version: 2,
      body: "Notes",
      author: { kind: "agent", name: "Bot" },
      createdAt: "2026-11-12T09:30:00.000Z",
    },
    comments: [
      comment(C1, { reviewId: REVIEW }),
      comment(C2, { reviewId: REVIEW, path: null, anchor: null }),
    ],
  };
  const { sent, transport } = transportAnswering(answer);
  const object = JSON.stringify({
    body: "Notes",
    comments: [
      { body: "One", path: "plan.md", lines: 3 },
      { body: "Two", path: "plan.md", lines: "4-6" },
      { body: "Three", replyTo: `c_${C3}`, anchor: { type: "file", data: {} } },
    ],
  });
  const said = (await runArtifact(
    invocation(["review", ID, "--rev", "2"]),
    transport,
    async () => object,
  )) as string;
  expect(sent[0]).toMatchObject({
    operation: "review",
    artifact: ID,
    body: "Notes",
    version: 2,
    comments: [
      { body: "One", path: "plan.md", anchor: { type: "lines", data: { start: 3, end: 3 } } },
      { body: "Two", path: "plan.md", anchor: { type: "lines", data: { start: 4, end: 6 } } },
      { body: "Three", replyTo: C3, anchor: { type: "file", data: {} } },
    ],
  });
  expect(said).toContain(`Posted review ${REVIEW} with 2 comments (version 2).`);
  expect(said).toContain(`c_${C1}`);
  await runArtifact(invocation(["review", ID]), transport, async () =>
    JSON.stringify([{ body: "Only" }]),
  );
  expect(sent[1]).toMatchObject({ operation: "review", comments: [{ body: "Only" }] });
  expect(sent[1]).not.toHaveProperty("body");
});

test("a review that is not JSON, or cannot be read as comments, is refused before anything is sent", async () => {
  const { sent, transport } = transportAnswering({});
  for (const [stdin, said] of [
    ["not json", "not JSON"],
    ["{}", "comments"],
    [JSON.stringify({ comments: "x" }), "comments"],
    [JSON.stringify([{ body: "x", lines: "9-" }]), "comments[0]: lines takes a line N or a range"],
    [
      JSON.stringify([{ body: "x", lines: 2, anchor: { type: "file", data: {} } }]),
      "comments[0]: give an anchor or lines, not both",
    ],
  ] as const) {
    const error = (await runArtifact(
      invocation(["review", ID]),
      transport,
      async () => stdin,
    ).catch((caught: unknown) => caught)) as CliError;
    expect(error, stdin).toBeInstanceOf(CliError);
    expect(error.message).toContain(said);
  }
  expect(sent).toEqual([]);
});

test("the rest of a review is the server's to judge: it is sent as written", async () => {
  const { sent, transport } = transportAnswering({});
  await runArtifact(invocation(["review", ID, "--json"]), transport, async () =>
    JSON.stringify({ body: 5, comments: [{ path: "a.md" }, 7, { body: " x ", extra: 1 }] }),
  );
  expect(sent[0]).toMatchObject({
    operation: "review",
    body: 5,
    comments: [{ path: "a.md" }, 7, { body: " x ", extra: 1 }],
  });
});

function serveProxy(body: unknown, status: number) {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch() {
      return Response.json(body, { status });
    },
  });
  servers.push(server);
  const proxyUrl = `http://127.0.0.1:${server.port}`;
  return (request: AgentArtifactRequest) =>
    artifactRequest(
      (path) => new URL(path, proxyUrl),
      `sfp_${"a".repeat(43)}`,
      proxyUrl,
      request,
    ).catch((caught: unknown) => caught as CliError);
}

test("a push or comment refused for unseen changes prints what was shown and the exact retry", async () => {
  const shown = {
    comments: [
      {
        id: C1,
        author: { kind: "user", name: "Alice" },
        version: 1,
        path: "plan.md",
        replyTo: null,
        body: "Please reword.",
        createdAt: "2026-11-12T09:30:00.000Z",
        images: [],
      },
    ],
    excerpts: [
      {
        id: C2,
        author: { kind: "user", name: "Bob" },
        path: null,
        version: 1,
        createdAt: "2026-11-12T09:31:00.000Z",
        excerpt: "Long text",
      },
    ],
    versions: [],
  };
  const refusal = (unread: number) =>
    serveProxy(
      {
        error: "conflict (artifact-unseen-changes): Held",
        code: "CONFLICT",
        retryable: false,
        details: {
          commentCount: 2,
          unread,
          versionCount: 0,
          skippedComments: 0,
          skippedVersions: 0,
          unseen: JSON.stringify(shown),
        },
      },
      409,
    );
  for (const request of [
    { operation: "push", artifact: ID, baseVersion: 1, idempotencyKey: ID, text: "x" },
    { operation: "comment", artifact: ID, body: "x", idempotencyKey: ID },
    { operation: "review", artifact: ID, comments: [{ body: "x" }], idempotencyKey: ID },
  ] as AgentArtifactRequest[]) {
    const error = (await refusal(0)(request)) as CliError;
    expect(error.code).toBe("CONFLICT");
    expect(error.contextText).toContain("Please reword.");
    expect(error.contextText).toContain("Long text");
    expect(error.suggestedNextAction).toContain("Run the same command again");
    expect(error.details).toMatchObject({ commentCount: 2 });
    expect(error.retryable).toBe(false);
    const unread = (await refusal(1)(request)) as CliError;
    expect(unread.suggestedNextAction).toContain(`coforge artifact comments ${ID}`);
  }
});

test("comments is a read; a comment, review, resolve or reopen that failed on the way may have landed", async () => {
  const unreachable = (request: AgentArtifactRequest) =>
    artifactRequest(
      () => new URL("http://127.0.0.1:1/api/agent/v1/artifacts"),
      `sfp_${"a".repeat(43)}`,
      "http://127.0.0.1:1",
      request,
    ).then(
      (): CliError => new CliError({ code: "UNEXPECTED", message: "the request succeeded" }),
      (caught: unknown) => caught as CliError,
    );
  expect((await unreachable({ operation: "comments", artifact: ID })).retryable).toBe(true);
  for (const request of [
    { operation: "comment", artifact: ID, body: "x", idempotencyKey: ID },
    { operation: "review", artifact: ID, comments: [{ body: "x" }], idempotencyKey: ID },
    { operation: "resolve", artifact: ID, comment: C1 },
    { operation: "reopen", artifact: ID, comment: C1 },
  ] as AgentArtifactRequest[]) {
    const error = await unreachable(request);
    expect(error.retryable).toBe(false);
    expect(error.suggestedNextAction).toContain(`coforge artifact comments ${ID} --all`);
  }
});

test("--help describes the comment commands", async () => {
  const transport = {} as MessageTransport;
  expect(await run(["artifact", "--help"], transport)).toContain(
    "comments|comment|review|resolve|reopen",
  );
  expect(await run(["artifact", "comments", "--help"], transport)).toContain(
    "coforge artifact comments <id>",
  );
  const comment = await run(["artifact", "comment", "--help"], transport);
  expect(comment).toContain("--reply-to");
  expect(comment).toContain("stdin");
  const review = await run(["artifact", "review", "--help"], transport);
  expect(review).toContain("coforge artifact review <id>");
  expect(review).toContain("comments");
  expect(await run(["artifact", "resolve", "--help"], transport)).toContain("--note");
  expect(await run(["artifact", "reopen", "--help"], transport)).toContain(
    "coforge artifact reopen <id> <comment>",
  );
  expect(await run(["artifact", "push", "--help"], transport)).toContain("artifact-unseen-changes");
});

test("comment --image is repeatable, takes no text, and uploads each image before sending", async () => {
  expect(invocation(["comment", ID, "--image", "a.png", "--image", "b.jpg"])).toEqual({
    command: "artifact",
    comment: { operation: "comment", artifact: ID, imagePaths: ["a.png", "b.jpg"] },
  });
  const dir = await mkdtemp(join(tmpdir(), "img-"));
  const png = join(dir, "a.png");
  await writeFile(png, Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));
  const text = join(dir, "notes.txt");
  await writeFile(text, "not an image");
  const sent: unknown[] = [];
  const uploaded: string[] = [];
  const transport = {
    artifact: async (request: AgentArtifactRequest) => {
      sent.push(request);
      return {
        id: C1,
        author: { kind: "agent", name: "me" },
        version: 1,
        path: null,
        replyTo: null,
        createdAt: "2026-11-12T09:30:00.000Z",
        reviewId: null,
        resolvedAt: null,
        resolvedBy: null,
      };
    },
    artifactUpload: async (sha256: string) => {
      uploaded.push(sha256);
    },
  };
  const draft = (paths: string[]) =>
    invocation(["comment", ID, ...paths.flatMap((path) => ["--image", path])]);
  await runArtifact(draft([png]), transport, async () => "");
  expect(uploaded).toHaveLength(1);
  expect(sent[0]).toMatchObject({ operation: "comment", images: uploaded });
  expect(sent[0]).not.toHaveProperty("body");
  await expect(runArtifact(draft([text]), transport, async () => "")).rejects.toThrow(
    "not a PNG, JPEG, GIF or WebP",
  );
  await expect(
    runArtifact(draft([png, png, png, png, png]), transport, async () => ""),
  ).rejects.toThrow("at most 4");
  await expect(runArtifact(invocation(["comment", ID]), transport, async () => "")).rejects.toThrow(
    "--image",
  );
  expect(sent).toHaveLength(1);
});

test("save takes an attachment id and prints what it made", async () => {
  expect(invocation(["save", ID])).toEqual({
    command: "artifact",
    request: { operation: "save", attachment: ID },
  });
  const said = (await runArtifact(invocation(["save", ID]), {
    artifact: async () => ({
      artifact: { id: C1, title: "Notes.md", entryPath: "Notes.md" },
      created: true,
      attachment: { id: ID, fileName: "Notes.md" },
      newlyFollowing: true,
    }),
  })) as string;
  expect(said).toContain('Saved attachment "Notes.md" as artifact "Notes.md"');
  const again = (await runArtifact(invocation(["save", ID]), {
    artifact: async () => ({
      artifact: { id: C1, title: "Notes.md" },
      created: false,
      attachment: { id: ID, fileName: "Notes.md" },
    }),
  })) as string;
  expect(again).toContain("was already saved");
});

test("download --image saves the image the server returns", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dl-"));
  const out = join(dir, "got.png");
  const bytes = Uint8Array.from([1, 2, 3, 4]);
  const said = (await runArtifact(
    invocation(["download", ID, "--image", "img1", "--output", out]),
    {
      artifact: async () => ({
        contentType: "image/png",
        sizeBytes: 4,
        data: Buffer.from(bytes).toString("base64"),
      }),
    },
  )) as string;
  expect(said).toContain("Saved image img1");
  expect(new Uint8Array(await readFile(out))).toEqual(bytes);
});
