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
    async (file) => (file === "-" ? "\n  Why three lines?\nSecond line.\n\n" : "wrong"),
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

test("a push or comment refused for unseen comments says how many and how to read them", async () => {
  const call = serveProxy(
    {
      error:
        "conflict (artifact-unseen-comments): 3 comments from others, new since you last read comments and about what this touches: read them with `coforge artifact comments x`, then send this again",
      code: "CONFLICT",
      retryable: false,
      details: { count: 3, commentIds: `${C1},${C2},${C3}` },
    },
    409,
  );
  for (const request of [
    { operation: "push", artifact: ID, baseVersion: 1, idempotencyKey: ID, text: "x" },
    { operation: "comment", artifact: ID, body: "x", idempotencyKey: ID },
    { operation: "review", artifact: ID, comments: [{ body: "x" }], idempotencyKey: ID },
  ] as AgentArtifactRequest[]) {
    const error = (await call(request)) as CliError;
    expect(error.code).toBe("CONFLICT");
    expect(error.message).toContain("3 comments from others");
    expect(error.suggestedNextAction).toBe(`Read them first: coforge artifact comments ${ID}`);
    expect(error.details).toMatchObject({ count: 3 });
    expect(error.retryable).toBe(false);
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
  expect(await run(["artifact", "push", "--help"], transport)).toContain(
    "artifact-unseen-comments",
  );
});
