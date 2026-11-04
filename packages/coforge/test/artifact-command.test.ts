import { afterEach, expect, test } from "bun:test";
import type { AgentArtifactRequest } from "@lrm/coforge-sdk/agent";
import { parseArgs, run, type MessageTransport } from "../index";
import {
  ARTIFACTS_DISABLED_MESSAGE,
  artifactRequest,
  runArtifact,
  type ArtifactInvocation,
} from "../src/artifact-commands";
import { CliError } from "../src/cli-error";

/** `coforge artifact create|list|read|push|history|revert` (task #385). */

const ID = "0f8c3b52-6d0e-4f3a-9a51-3c1d2e4f5a6b";
const servers: { stop(): void }[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
});

test("each artifact command parses into its own request", () => {
  expect(
    parseArgs(["artifact", "create", "--title", "Plan", "--target", "#launch", "--file", "-"]),
  ).toEqual({
    command: "artifact",
    request: { operation: "create", title: "Plan", target: "#launch" },
    file: "-",
  });
  expect(parseArgs(["artifact", "read", ID, "--version", "2", "--json"])).toEqual({
    command: "artifact",
    request: { operation: "read", artifact: ID, version: 2 },
    json: true,
  });
  expect(
    parseArgs(["artifact", "push", ID, "--base", "3", "--file", "plan.md", "--note", "date"]),
  ).toEqual({
    command: "artifact",
    request: { operation: "push", artifact: ID, baseVersion: 3, note: "date" },
    file: "plan.md",
  });
  expect(parseArgs(["artifact", "revert", ID, "--to", "1", "--base", "4"])).toMatchObject({
    request: { operation: "revert", artifact: ID, to: 1, baseVersion: 4 },
  });
  expect(parseArgs(["artifact", "history", ID, "--before", "9"])).toMatchObject({
    request: { operation: "history", artifact: ID, before: 9 },
  });
  expect(parseArgs(["artifact", "list", "--target", "#launch"])).toEqual({
    command: "artifact",
    request: { operation: "list", target: "#launch" },
  });
  expect(parseArgs(["artifact", "list"])).toEqual({
    command: "artifact",
    request: { operation: "list" },
  });
});

test("create --kind html makes a web page, which needs its one-line description", () => {
  expect(
    parseArgs([
      "artifact",
      "create",
      "--kind",
      "html",
      "--title",
      "Funnel",
      "--description",
      " Signups by day ",
      "--file",
      "index.html",
    ]),
  ).toEqual({
    command: "artifact",
    request: { operation: "create", title: "Funnel", kind: "html", description: "Signups by day" },
    file: "index.html",
  });
  expect(() => parseArgs(["artifact", "create", "--kind", "html", "--title", "Funnel"])).toThrow(
    "--kind html needs --description",
  );
  expect(() => parseArgs(["artifact", "create", "--kind", "pdf", "--title", "Funnel"])).toThrow(
    "--kind is markdown (a document) or html (a web page)",
  );
});

test("an artifact command missing what it needs names its help", () => {
  for (const args of [
    ["artifact", "delete", ID],
    ["artifact", "create"],
    ["artifact", "read"],
    ["artifact", "push", ID, "--file", "a.md"],
    ["artifact", "push", ID, "--base", "2"],
    ["artifact", "push", ID, "--base", "-1", "--file", "a.md"],
    ["artifact", "revert", ID, "--to", "1"],
    ["artifact", "read", ID, "--exact-base"],
  ])
    expect(() => parseArgs(args)).toThrow(CliError);
});

test("artifact --help describes the family and each command", async () => {
  const transport = {} as MessageTransport;
  expect(await run(["artifact", "--help"], transport)).toContain(
    "coforge artifact create|list|read|push|history|revert",
  );
  expect(await run(["artifact", "push", "--help"], transport)).toContain("ARTIFACT_CONFLICT");
  expect(await run(["artifact", "list", "--help"], transport)).toContain("coforge artifact list");
});

function transportAnswering(answer: unknown) {
  const sent: AgentArtifactRequest[] = [];
  return {
    sent,
    transport: {
      artifact: async (request: AgentArtifactRequest) => {
        sent.push(request);
        return answer;
      },
    },
  };
}

const invocation = (args: string[]) => parseArgs(["artifact", ...args]) as ArtifactInvocation;

test("a save sends the file's text with a fresh idempotency key and says what it made", async () => {
  const { sent, transport } = transportAnswering({
    status: "created",
    number: 4,
    merged: ["document.md"],
    mergedSettings: [],
  });
  const said = await runArtifact(
    invocation(["push", ID, "--base", "3", "--file", "plan.md"]),
    transport,
    async (file) => `text of ${file}`,
  );
  expect(sent[0]).toMatchObject({ operation: "push", baseVersion: 3, text: "text of plan.md" });
  expect(sent[0]).toHaveProperty("idempotencyKey");
  expect(said).toContain("Saved version 4.");
  expect(said).toContain("Merged with what others saved since version 3: document.md");
});

test("a conflict prints the document with markers to stdout and fails", async () => {
  const { transport } = transportAnswering({
    status: "conflict",
    currentVersion: 5,
    files: [
      {
        path: "document.md",
        chunks: [
          { ok: "# Plan\n\n" },
          {
            conflict: {
              base: "Ship in May.\n",
              mine: "Ship in July.\n",
              theirs: "Ship in June.\n",
            },
          },
          { ok: "\nRisks.\n" },
        ],
      },
    ],
    settings: [{ name: "title", base: "Plan", mine: "Plan B", theirs: "Plan C" }],
  });
  const error = await runArtifact(
    invocation(["push", ID, "--base", "3", "--file", "plan.md"]),
    transport,
    async () => "x",
  ).catch((caught: unknown) => caught as CliError);
  expect(error).toBeInstanceOf(CliError);
  const cli = error as CliError;
  expect(cli.code).toBe("ARTIFACT_CONFLICT");
  expect(cli.stdoutText).toBe(
    "# Plan\n\n<<<<<<< yours\nShip in July.\n||||||| before both\nShip in May.\n=======\nShip in June.\n>>>>>>> theirs\n\nRisks.\n",
  );
  expect(cli.message).toContain('title: yours "Plan B", theirs "Plan C"');
  expect(cli.suggestedNextAction).toContain(`coforge artifact push ${ID} --base 5`);
});

test("list prints a line per document, newest first, and how to read one", async () => {
  const { sent, transport } = transportAnswering([
    {
      id: ID,
      name: "launch-plan",
      title: "Launch plan",
      currentVersion: 4,
      updatedAt: "2026-11-04T02:00:00Z",
    },
    {
      id: "a1",
      name: "notes",
      title: "Notes",
      currentVersion: 1,
      updatedAt: "2026-11-03T09:00:00Z",
    },
  ]);
  const said = (await runArtifact(
    invocation(["list", "--target", "#launch"]),
    transport,
  )) as string;
  expect(sent[0]).toEqual({ operation: "list", target: "#launch" });
  expect(said).toContain(`"Launch plan" (id ${ID}), version 4`);
  expect(said).toContain('"Notes" (id a1), version 1');
  expect(said).toContain(`coforge artifact read <id>`);
});

test("list says plainly when a home has no documents", async () => {
  const { transport } = transportAnswering([]);
  const said = (await runArtifact(invocation(["list"]), transport)) as string;
  expect(said).toBe("No documents here yet.");
});

test("read prints the version to save over, then the text", async () => {
  const { transport } = transportAnswering({
    artifact: { id: ID, title: "Plan", currentVersion: 3 },
    version: { number: 3, label: null },
    files: [],
    text: "# Plan\n",
  });
  const said = await runArtifact(invocation(["read", ID]), transport);
  expect(said).toBe(
    `Document "Plan" (id ${ID}), version 3 of 3.\nSave over it: coforge artifact push ${ID} --base 3 --file <path>\n---\n# Plan\n`,
  );
});

function serveProxy(body: unknown, status: number) {
  const seen: unknown[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      seen.push(await request.json());
      return Response.json(body, { status });
    },
  });
  servers.push(server);
  const proxyUrl = `http://127.0.0.1:${server.port}`;
  return {
    seen,
    call: (request: AgentArtifactRequest) =>
      artifactRequest(
        (path) => new URL(path, proxyUrl),
        `sfp_${"a".repeat(43)}`,
        proxyUrl,
        request,
      ),
  };
}

test("a Workspace without documents is said plainly", async () => {
  const proxy = serveProxy(
    {
      error: "forbidden (artifacts-disabled): this Workspace has not enabled documents",
      code: "ACCESS_DENIED",
      retryable: false,
    },
    403,
  );
  const error = (await proxy
    .call({ operation: "read", artifact: ID })
    .catch((caught: unknown) => caught)) as CliError;
  expect(error.code).toBe("ARTIFACTS_DISABLED");
  expect(error.message).toBe(ARTIFACTS_DISABLED_MESSAGE);
  expect(error.message).toStartWith("这个工作区没有开启文档");
  expect(proxy.seen).toEqual([{ operation: "read", artifact: ID }]);
});

test("another refusal keeps the server's code and reason", async () => {
  const proxy = serveProxy({ error: "not found", code: "NOT_FOUND", retryable: false }, 404);
  const error = (await proxy
    .call({ operation: "read", artifact: ID })
    .catch((caught: unknown) => caught)) as CliError;
  expect(error.code).toBe("NOT_FOUND");
  expect(error.message).toBe("artifact read failed: not found");
});

test("a refusal under --json is printed as JSON", async () => {
  const transport = {
    artifact: async () => {
      throw new CliError({ code: "NOT_FOUND", message: "artifact read failed: not found" });
    },
  };
  const error = (await runArtifact(invocation(["read", ID, "--json"]), transport).catch(
    (caught: unknown) => caught,
  )) as CliError;
  expect(error.outputMode).toBe("json");
});

test("a write that may have landed is not called retryable, and says what to check", async () => {
  const unreachable = (request: AgentArtifactRequest) =>
    artifactRequest(
      () => new URL("http://127.0.0.1:1/api/agent/v1/artifacts"),
      `sfp_${"a".repeat(43)}`,
      "http://127.0.0.1:1",
      request,
    ).then(
      () => new CliError({ code: "UNEXPECTED", message: "the request succeeded" }),
      (caught: unknown) => caught as CliError,
    );
  const create = await unreachable({ operation: "create", title: "Plan" });
  expect(create.retryable).toBe(false);
  expect(create.suggestedNextAction).toContain("second one");
  const read = await unreachable({ operation: "read", artifact: ID });
  expect(read.retryable).toBe(true);

  const proxy = serveProxy({ error: "upstream failed", code: "UPSTREAM_FAILED" }, 502);
  const push = (await proxy
    .call({ operation: "push", artifact: ID, baseVersion: 1, idempotencyKey: ID, text: "x" })
    .catch((caught: unknown) => caught)) as CliError;
  expect(push.suggestedNextAction).toContain(`coforge artifact read ${ID}`);
  expect(push.retryable).toBe(false);
  // The same failure on a read is worth another try.
  const failedRead = (await proxy
    .call({ operation: "read", artifact: ID })
    .catch((caught: unknown) => caught)) as CliError;
  expect(failedRead.retryable).toBe(true);
});

test("a save over a version that is no longer current says to read again", async () => {
  const proxy = serveProxy(
    { error: "conflict (artifact-base-moved)", code: "CONFLICT", proxy: { correlation_id: "c1" } },
    409,
  );
  const error = (await proxy
    .call({ operation: "revert", artifact: ID, to: 1, baseVersion: 2, idempotencyKey: ID })
    .catch((caught: unknown) => caught)) as CliError;
  expect(error.code).toBe("CONFLICT");
  expect(error.suggestedNextAction).toContain(`coforge artifact read ${ID}`);
  expect(error.correlationId).toBe("c1");
});
