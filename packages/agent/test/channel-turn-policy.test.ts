import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession } from "#src/runner";

function completion(message: Record<string, unknown>, finishReason: string) {
  const choice = { index: 0, delta: message, finish_reason: finishReason };
  return new Response(
    `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [choice] })}\n\ndata: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
}
function call(name: string, args: Record<string, unknown>, id: string) {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}
async function fixture(
  serverUrl: string,
  root: string,
  toolProfile?: "openviking-memory",
  environment: Record<string, string> = {},
) {
  const agentDir = join(root, "config");
  await Bun.write(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        fixture: {
          api: "openai-completions",
          baseUrl: serverUrl + "v1",
          apiKey: "fixture-key",
          models: [
            {
              id: "custom",
              name: "fixture",
              input: ["text"],
              contextWindow: 32000,
              maxTokens: 1000,
            },
          ],
        },
      },
    }),
  );
  await Bun.write(join(root, "coforge"), "#!/bin/sh\nprintf 'No new messages.\\n'\n");
  await chmod(join(root, "coforge"), 0o755);
  return createSession({
    cwd: root,
    agentDir,
    modelProvider: "fixture",
    model: "custom",
    apiKey: "fixture-key",
    instructions: "Fixture only.",
    toolProfile,
    environment: {
      PATH: root + ":" + (Bun.env.PATH ?? ""),
      COFORGE_EVAL_DISABLE_HOST_PI_INJECTION: "1",
      ...environment,
    },
  });
}

test("empty channel polling settles the native turn and a later input resumes it", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-channel-idle-"));
  let requests = 0;
  const server = Bun.serve({
    port: 0,
    fetch() {
      requests++;
      return requests <= 2
        ? completion(
            {
              role: "assistant",
              tool_calls: [
                call(
                  "bash",
                  { command: "coforge message check --target '#team'" },
                  `poll-${requests}`,
                ),
              ],
            },
            "tool_calls",
          )
        : completion({ role: "assistant", content: "resumed" }, "stop");
    },
  });
  let created: Awaited<ReturnType<typeof createSession>> | undefined;
  try {
    created = await fixture(String(server.url), root);
    await created.session.prompt("Wait for the Memory reply.");
    expect(requests).toBe(2);
    await created.session.prompt("The Memory reply is now available.");
    expect(requests).toBe(3);
    expect(created.session.agent.state.messages.at(-1)?.role).toBe("assistant");
  } finally {
    await created?.dispose();
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);

test("a published Memory Offer settles without an extra model request", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-offer-settle-"));
  const citation = {
    kind: "openviking",
    citationId: "ov:doc",
    workspaceId: "ws",
    accountId: "acct",
    uri: "viking://resources/doc.md",
    contentHash: "sha256:test",
    matchedLevel: "L2",
    excerpt: "Source evidence.",
  };
  const proxy = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { op: string; operationId: string };
      return Response.json({
        protocol: "coforge.openviking.agent.v1",
        op: body.op,
        operationId: body.operationId,
        duplicate: false,
        ...(body.op === "offer"
          ? {
              published: true,
              messageId: "published-offer",
              recipientAgentId: "task",
              citations: [citation],
            }
          : { items: [citation] }),
      });
    },
  });
  let requests = 0;
  const server = Bun.serve({
    port: 0,
    fetch() {
      requests++;
      if (requests === 1)
        return completion(
          {
            role: "assistant",
            tool_calls: [
              call("ov_fork_find", { operationId: "find-1", query: "evidence" }, "fork_find"),
            ],
          },
          "tool_calls",
        );
      if (requests === 2)
        return completion(
          {
            role: "assistant",
            tool_calls: [
              call(
                "memory_offer",
                {
                  operationId: "offer-1",
                  citationRefs: ["ov:doc"],
                  body: "Partial source evidence; the remaining constraints are unresolved.",
                },
                "offer",
              ),
            ],
          },
          "tool_calls",
        );
      return completion({ role: "assistant", content: "unwanted follow-up" }, "stop");
    },
  });
  let created: Awaited<ReturnType<typeof createSession>> | undefined;
  try {
    created = await fixture(String(server.url), root, "openviking-memory", {
      COFORGE_AGENT_PROXY_URL: String(proxy.url),
      COFORGE_AGENT_CONTEXT: "fixture-context",
    });
    await created.session.prompt("Retrieve evidence and provide an Offer.");
    expect(requests).toBe(2);
    const last = created.session.agent.state.messages.at(-1);
    expect(last?.role).toBe("toolResult");
    const text =
      last?.role === "toolResult" ? last.content.find((item) => item.type === "text")?.text : "{}";
    expect(JSON.parse(text ?? "{}").published).toBe(true);
  } finally {
    await created?.dispose();
    server.stop(true);
    proxy.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);

test("a notice queued while an empty poll is running is not discarded", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-idle-queued-"));
  const secondRequest = Promise.withResolvers<void>();
  const releaseSecond = Promise.withResolvers<void>();
  let requests = 0;
  const server = Bun.serve({
    port: 0,
    async fetch() {
      requests++;
      if (requests === 2) {
        secondRequest.resolve();
        await releaseSecond.promise;
      }
      return requests <= 2
        ? completion(
            {
              role: "assistant",
              tool_calls: [
                call(
                  "bash",
                  { command: "coforge message check --target '#team'" },
                  `poll-${requests}`,
                ),
              ],
            },
            "tool_calls",
          )
        : completion({ role: "assistant", content: "handled queued notice" }, "stop");
    },
  });
  let created: Awaited<ReturnType<typeof createSession>> | undefined;
  let pending: Promise<void> | undefined;
  try {
    created = await fixture(String(server.url), root);
    pending = created.session.prompt("Wait for Memory.");
    await secondRequest.promise;
    await created.session.steer("Memory has supplied fresh evidence.");
    releaseSecond.resolve();
    await pending;
    expect(requests).toBe(3);
    expect(JSON.stringify(created.session.agent.state.messages)).toContain(
      "Memory has supplied fresh evidence.",
    );
    expect(JSON.stringify(created.session.agent.state.messages.at(-1))).toContain(
      "handled queued notice",
    );
  } finally {
    releaseSecond.resolve();
    await pending?.catch(() => {});
    await created?.dispose();
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);

test("useful work between empty checks resets idle detection", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-idle-progress-"));
  let requests = 0;
  const server = Bun.serve({
    port: 0,
    fetch() {
      requests++;
      if (requests <= 3)
        return completion(
          {
            role: "assistant",
            tool_calls: [
              call(
                "bash",
                {
                  command:
                    requests === 2
                      ? "printf 'useful work\\n'"
                      : "coforge message check --target '#team'",
                },
                `work-${requests}`,
              ),
            ],
          },
          "tool_calls",
        );
      return completion({ role: "assistant", content: "completed useful work" }, "stop");
    },
  });
  let created: Awaited<ReturnType<typeof createSession>> | undefined;
  try {
    created = await fixture(String(server.url), root);
    await created.session.prompt("Work while awaiting a reply.");
    expect(requests).toBe(4);
    expect(JSON.stringify(created.session.agent.state.messages.at(-1))).toContain(
      "completed useful work",
    );
  } finally {
    await created?.dispose();
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);

test("a published autonomous diagnosis settles the native turn without another model request", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-diagnosis-settled-"));
  let requests = 0;
  const proxy = Bun.serve({
    port: 0,
    async fetch(request) {
      const command = (await request.json()) as { operationId: string; messageId: string };
      return Response.json({
        protocol: "coforge.openviking.agent.v1",
        op: "diagnose",
        operationId: command.operationId,
        status: "completed",
        published: true,
        duplicate: false,
        messageId: "diagnosis-report",
      });
    },
  });
  const server = Bun.serve({
    port: 0,
    fetch() {
      requests++;
      return requests === 1
        ? completion(
            {
              role: "assistant",
              tool_calls: [
                call(
                  "memory_diagnose",
                  {
                    operationId: "state-diagnosis",
                    messageId: "11111111-1111-4111-8111-111111111111",
                  },
                  "diagnose",
                ),
              ],
            },
            "tool_calls",
          )
        : completion({ role: "assistant", content: "unwanted extra handoff" }, "stop");
    },
  });
  let created: Awaited<ReturnType<typeof createSession>> | undefined;
  try {
    created = await fixture(String(server.url), root, "openviking-memory", {
      COFORGE_AGENT_PROXY_URL: String(proxy.url),
      COFORGE_AGENT_CONTEXT: "fixture-context",
    });
    await created.session.prompt(
      "The Task has repeated the failed search. Diagnose its saved state.",
    );
    expect(requests).toBe(1);
    expect(created.session.agent.state.messages.at(-1)?.role).toBe("toolResult");
  } finally {
    await created?.dispose();
    server.stop(true);
    proxy.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 10000);

test("QA send settlement ends a receipted channel send and later inbox input resumes", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-channel-sent-"));
  let requests = 0;
  const server = Bun.serve({
    port: 0,
    fetch() {
      requests++;
      return requests === 1
        ? completion(
            {
              role: "assistant",
              tool_calls: [
                call(
                  "bash",
                  { command: "coforge message send --target '#team' --message 'A response'" },
                  "send",
                ),
              ],
            },
            "tool_calls",
          )
        : completion({ role: "assistant", content: "resumed" }, "stop");
    },
  });
  let created: Awaited<ReturnType<typeof createSession>> | undefined;
  try {
    created = await fixture(String(server.url), root, undefined, {
      COFORGE_EVAL_SETTLE_SENDS: "1",
    });
    await Bun.write(
      join(root, "coforge"),
      "#!/bin/sh\nprintf 'Message sent to #team. Message ID: 00000000-0000-4000-8000-000000000001\\n'\n",
    );
    await created.session.prompt("Send a response, then wait for another input.");
    expect(requests).toBe(1);
    await created.session.prompt("A later inbox message arrived.");
    expect(requests).toBe(2);
  } finally {
    await created?.dispose();
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);

test.each([
  {
    name: "JSON accepted send",
    output: '{"accepted":true,"messageId":"sent-id"}',
    enabled: "1",
    exit: 0,
    requests: 1,
  },
  {
    name: "draft awaiting confirmation",
    output: '{"state":"draft","messageId":"draft-id"}',
    enabled: "1",
    exit: 0,
    requests: 2,
  },
  {
    name: "missing send receipt id",
    output: '{"accepted":true}',
    enabled: "1",
    exit: 0,
    requests: 2,
  },
  {
    name: "failed command",
    output: "Message sent to #team. Message ID: 00000000-0000-4000-8000-000000000001",
    enabled: "1",
    exit: 1,
    requests: 2,
  },
  {
    name: "default product turn",
    output: "Message sent to #team. Message ID: 00000000-0000-4000-8000-000000000001",
    enabled: "0",
    exit: 0,
    requests: 2,
  },
])(
  "channel send settlement handles $name",
  async (scenario) => {
    const root = await mkdtemp(join(tmpdir(), "coforge-send-receipt-"));
    let requests = 0;
    const server = Bun.serve({
      port: 0,
      fetch() {
        requests++;
        return requests === 1
          ? completion(
              {
                role: "assistant",
                tool_calls: [
                  call(
                    "bash",
                    { command: "coforge message send --target '#team' --message 'A response'" },
                    "send",
                  ),
                ],
              },
              "tool_calls",
            )
          : completion({ role: "assistant", content: "Handle result normally." }, "stop");
      },
    });
    let created: Awaited<ReturnType<typeof createSession>> | undefined;
    try {
      created = await fixture(String(server.url), root, undefined, {
        COFORGE_EVAL_SETTLE_SENDS: scenario.enabled,
      });
      await Bun.write(
        join(root, "coforge"),
        `#!/bin/sh\ncat <<'RECEIPT'\n${scenario.output}\nRECEIPT\nexit ${scenario.exit}\n`,
      );
      await created.session.prompt("Send the response and handle the receipt.");
      expect(requests).toBe(scenario.requests);
    } finally {
      await created?.dispose();
      server.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  },
  10_000,
);

test("a notice queued during a receipted send survives turn settlement", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-send-queued-"));
  const sending = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let requests = 0;
  const server = Bun.serve({
    port: 0,
    async fetch() {
      requests++;
      if (requests === 1) {
        sending.resolve();
        await release.promise;
        return completion(
          {
            role: "assistant",
            tool_calls: [
              call(
                "bash",
                { command: "coforge message send --target '#team' --message 'Request evidence'" },
                "send",
              ),
            ],
          },
          "tool_calls",
        );
      }
      return completion({ role: "assistant", content: "handled fresh evidence" }, "stop");
    },
  });
  let created: Awaited<ReturnType<typeof createSession>> | undefined;
  let pending: Promise<void> | undefined;
  try {
    created = await fixture(String(server.url), root, undefined, {
      COFORGE_EVAL_SETTLE_SENDS: "1",
    });
    await Bun.write(
      join(root, "coforge"),
      "#!/bin/sh\nprintf 'Message sent to #team. Message ID: 00000000-0000-4000-8000-000000000001\\n'\n",
    );
    pending = created.session.prompt("Request evidence from Memory.");
    await sending.promise;
    await created.session.steer("Memory has supplied fresh evidence.");
    release.resolve();
    await pending;
    expect(requests).toBe(2);
    expect(JSON.stringify(created.session.agent.state.messages)).toContain(
      "Memory has supplied fresh evidence.",
    );
    expect(JSON.stringify(created.session.agent.state.messages.at(-1))).toContain(
      "handled fresh evidence",
    );
  } finally {
    release.resolve();
    await pending?.catch(() => {});
    await created?.dispose();
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);
