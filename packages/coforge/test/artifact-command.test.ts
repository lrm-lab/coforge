import { afterEach, expect, test } from "bun:test";
import type { AgentArtifactRequest } from "@lrm/coforge-sdk/agent";
import { parseArgs, run, type MessageTransport } from "../index";
import {
  artifactRequest,
  runArtifact,
  type ArtifactInvocation,
  type ArtifactRequestInvocation,
} from "../src/artifact-commands";
import { ARTIFACTS_DISABLED_MESSAGE } from "../src/artifact-failure";
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
    request: { operation: "list", target: "#launch", limit: 20 },
  });
  expect(parseArgs(["artifact", "list"])).toEqual({
    command: "artifact",
    request: { operation: "list", limit: 20 },
  });
  const shared = parseArgs([
    "artifact",
    "share",
    ID,
    "a1",
    "--to",
    "#launch",
    "--target",
    "@ada",
    "--note",
    "Read this",
  ]) as ArtifactRequestInvocation;
  expect(shared.request).toMatchObject({
    operation: "share",
    artifactIds: [ID, "a1"],
    targets: ["#launch", "@ada"],
    note: "Read this",
  });
  expect(
    (shared.request as Extract<AgentArtifactRequest, { operation: "share" }>).requestId,
  ).toBeString();
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
    "--kind is markdown (Markdown text) or html (a web page)",
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
  expect(await run(["artifact", "push", "--help"], transport)).toContain(
    "artifact-agent-base-moved",
  );
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
    merged: ["artifact.md"],
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
  expect(said).toContain("Merged with what others saved since version 3: artifact.md");
});

test("list prints a line per artifact, newest first, and how to read one", async () => {
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
  expect(sent[0]).toEqual({ operation: "list", target: "#launch", limit: 20 });
  expect(said).toContain(`"Launch plan" (id ${ID}), version 4`);
  expect(said).toContain('"Notes" (id a1), version 1');
  expect(said).toContain(`coforge artifact read <id>`);
});

test("list says plainly when a home has no artifacts", async () => {
  const { transport } = transportAnswering([]);
  const said = (await runArtifact(invocation(["list"]), transport)) as string;
  expect(said).toBe("No artifacts here yet.");
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
    `Artifact "Plan" (id ${ID}), version 3 of 3.\nSave over it: coforge artifact push ${ID} --base 3 --file <path>\n---\n# Plan\n`,
  );
});

const readAnswer = (unseen: unknown) => ({
  artifact: { id: ID, title: "Plan", currentVersion: 6 },
  version: { number: 6, label: null },
  entryPath: "document.md",
  files: [{ path: "document.md", sha256: "a".repeat(64), sizeBytes: 12, kind: "text" }],
  text: "# Plan\n",
  unseen,
});

const unseenVersion = (number: number, extra: Record<string, unknown> = {}) => ({
  number,
  publisher: { kind: "user", name: "Alice" },
  createdAt: "2026-11-12T09:30:00.000Z",
  note: "moved the date",
  label: "",
  changedPaths: ["a.md", "b.css"],
  changedCount: 2,
  ...extra,
});

test("read lists what others pushed since the last look, after the files", async () => {
  const { transport } = transportAnswering(
    readAnswer({
      firstRead: false,
      versionCount: 7,
      versions: [
        unseenVersion(6),
        unseenVersion(5, {
          publisher: { kind: "agent", name: "Writer Bot" },
          note: "",
          label: "draft",
          changedPaths: [],
          changedCount: 0,
        }),
        unseenVersion(4, { note: "line one\nline two", changedPaths: ["a.md"], changedCount: 1 }),
        unseenVersion(3),
        unseenVersion(2),
      ],
    }),
  );
  const said = (await runArtifact(invocation(["read", ID]), transport)) as string;
  const lines = said.split("\n");
  const files = lines.indexOf("Work on them as files: coforge artifact pull " + ID);
  expect(lines.slice(files + 1, files + 8)).toEqual([
    "New since you last looked: 7 versions",
    "- v6 by Alice, 2026-11-12 09:30:00Z: moved the date (changed: a.md, b.css)",
    "- v5 by Writer Bot, 2026-11-12 09:30:00Z: draft",
    "- v4 by Alice, 2026-11-12 09:30:00Z: line one line two (changed: a.md)",
    "- v3 by Alice, 2026-11-12 09:30:00Z: moved the date (changed: a.md, b.css)",
    "- v2 by Alice, 2026-11-12 09:30:00Z: moved the date (changed: a.md, b.css)",
    "- … 2 versions earlier",
  ]);
  expect(lines[files + 8]).toBe("---");
});

test("read names four changed paths, then how many more, by the total the server counted", async () => {
  const paths = Array.from({ length: 10 }, (_, n) => `f${n}.md`);
  const { transport } = transportAnswering(
    readAnswer({
      firstRead: false,
      versionCount: 1,
      versions: [unseenVersion(6, { changedPaths: paths, changedCount: 14 })],
    }),
  );
  const said = (await runArtifact(invocation(["read", ID]), transport)) as string;
  expect(said).toContain(
    "- v6 by Alice, 2026-11-12 09:30:00Z: moved the date (changed: f0.md, f1.md, f2.md, f3.md, +10 more)",
  );
});

test("read on a first look says so, and lists the newest versions of others", async () => {
  const { transport } = transportAnswering(
    readAnswer({
      firstRead: true,
      versionCount: 2,
      versions: [unseenVersion(6), unseenVersion(5)],
    }),
  );
  const said = (await runArtifact(invocation(["read", ID]), transport)) as string;
  expect(said).toContain(
    [
      "You haven't read it before: 2 versions so far. The newest:",
      "- v6 by Alice, 2026-11-12 09:30:00Z: moved the date (changed: a.md, b.css)",
      "- v5 by Alice, 2026-11-12 09:30:00Z: moved the date (changed: a.md, b.css)",
      "---",
    ].join("\n"),
  );
});

test("read says plainly when nothing from others is new", async () => {
  const none = { versionCount: 0, versions: [] };
  const again = await runArtifact(
    invocation(["read", ID]),
    transportAnswering(readAnswer({ firstRead: false, ...none })).transport,
  );
  expect(again).toContain("Nothing new since you last looked.\n---");
  const first = await runArtifact(
    invocation(["read", ID]),
    transportAnswering(readAnswer({ firstRead: true, ...none })).transport,
  );
  expect(first).toContain("Your first read of it: nothing from others to show.\n---");
});

test("read of an older version, or from an older server, prints nothing about what is new", async () => {
  for (const unseen of [null, undefined]) {
    const said = (await runArtifact(
      invocation(["read", ID, "--version", "2"]),
      transportAnswering(readAnswer(unseen)).transport,
    )) as string;
    expect(said).not.toContain("since you last looked");
    expect(said).not.toContain("first read");
    expect(said).not.toContain("haven't read");
  }
});

test("read --json prints the server's answer as it is, with what is new", async () => {
  const answer = readAnswer({ firstRead: true, versionCount: 1, versions: [unseenVersion(6)] });
  const said = await runArtifact(
    invocation(["read", ID, "--json"]),
    transportAnswering(answer).transport,
  );
  expect(said).toEqual(answer);
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

test("a Workspace without artifacts is said plainly", async () => {
  const proxy = serveProxy(
    {
      error: "forbidden (artifacts-disabled): this Workspace has not enabled artifacts",
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
  expect(error.message).toStartWith("这个工作区没有开启 artifacts");
  // The refusal must name the working alternative, so an Agent does not retry artifacts or
  // report a send that never happened (task #711).
  expect(error.message).toContain("attachment");
  expect(error.message).toContain("coforge attachment upload");
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
