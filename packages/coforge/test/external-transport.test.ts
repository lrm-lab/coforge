import { expect, test } from "bun:test";
import { run } from "../index";
import { connectLocal } from "../src/local-client";
import { connectExternal } from "../src/external/direct-transport";
import { resolveAgentTransport } from "../src/external/resolve-transport";
import { runExternalWhoami } from "../src/external/whoami-external";
import { parseWhoamiArgs } from "../src/whoami";
import {
  OLD_KEY,
  SERVER,
  fakeFetch,
  json,
  profile,
  useAgentHome,
  withGlobalFetch,
  type Handler,
} from "./external-fixture";
import { afterEach } from "bun:test";

const home = useAgentHome();
let restore = () => {};
afterEach(() => restore());

function connect(handler: Handler) {
  const fake = fakeFetch(handler);
  // A second connect in one test must not capture the first fake as "the original" fetch.
  restore();
  const undo = withGlobalFetch(fake.fetch);
  restore = () => {
    undo();
    restore = () => {};
  };
  const session = { slug: "p", path: home.store.pathOf("p"), profile: profile() };
  return { ...connectExternal(session, home.store), requests: fake.requests, session };
}

const message = (id: string, body = "hi") => ({
  id,
  sequence: 1,
  senderKind: "human",
  senderHandle: "ada",
  senderDescription: "",
  target: "#general",
  body,
  createdAt: "2026-11-16T00:00:00.000Z",
  attachments: [],
});

test("with no profile the transport is the daemon proxy, unchanged", async () => {
  const env = {
    COFORGE_DAEMON_SOCKET: "",
    COFORGE_AGENT_CONTEXT: `sfp_${"d".repeat(43)}`,
    COFORGE_AGENT_PROXY_URL: "http://127.0.0.1:9",
  };
  expect(await resolveAgentTransport(env, undefined, home.store)).toEqual({
    mode: "daemon",
    socketPath: "",
    context: env.COFORGE_AGENT_CONTEXT,
    proxyUrl: env.COFORGE_AGENT_PROXY_URL,
  });
});

test("a profile ignores the daemon environment and targets the server with its key", async () => {
  await home.store.writeProfile("p", profile());
  const target = await resolveAgentTransport(
    {
      COFORGE_AGENT_CONTEXT: `sfp_${"d".repeat(43)}`,
      COFORGE_AGENT_PROXY_URL: "http://127.0.0.1:9",
    },
    "p",
    home.store,
  );
  expect(target).toMatchObject({
    mode: "external",
    profileSlug: "p",
    profile: { apiKey: OLD_KEY, serverUrl: SERVER },
  });
});

test("a profile that was never logged in is refused", async () => {
  await expect(resolveAgentTransport({}, "p", home.store)).rejects.toMatchObject({
    code: "PROFILE_NOT_LOGGED_IN",
  });
});

test("the shared client sends to the server origin with the key, not to a proxy", async () => {
  const fake = fakeFetch(() =>
    json({
      idempotencyKey: "k",
      workspace: { id: "w", slug: "acme", name: "A" },
      humans: [],
      agents: [],
      projects: [],
    }),
  );
  // A second connect in one test must not capture the first fake as "the original" fetch.
  restore();
  const undo = withGlobalFetch(fake.fetch);
  restore = () => {
    undo();
    restore = () => {};
  };
  const transport = connectLocal("", OLD_KEY, SERVER, "");
  await transport.workspaceInfo();
  expect(fake.requests[0]!.url.href).toBe(`${SERVER}/api/agent/v1/workspace`);
  expect(fake.requests[0]!.headers.get("authorization")).toBe(`Bearer ${OLD_KEY}`);
});

test("message check sends the stored cursor as since and stores the new one only on commit", async () => {
  await home.store.writeCursor("p", "old-cursor");
  const t = connect(() =>
    json({
      idempotencyKey: "k",
      events: [message("11111111-1111-4111-8111-111111111111")],
      hasMore: false,
      cursor: "new-cursor",
    }),
  );
  const output = await run(["message", "check"], t.transport);
  expect(t.requests[0]!.url.pathname).toBe("/api/agent/v1/events");
  expect(t.requests[0]!.url.searchParams.get("since")).toBe("old-cursor");
  expect(t.requests[0]!.headers.get("authorization")).toBe(`Bearer ${OLD_KEY}`);
  expect(output).toContain("hi");
  expect(await home.store.readCursor("p")).toBe("old-cursor");
  await t.commit();
  expect(await home.store.readCursor("p")).toBe("new-cursor");
});

test("a first message check sends no since, and an unusable cursor is dropped once", async () => {
  const first = connect(() => json({ events: [], hasMore: false, cursor: "c1" }));
  await run(["message", "check"], first.transport);
  expect(first.requests[0]!.url.searchParams.has("since")).toBe(false);

  await home.store.writeCursor("p", "stale");
  let calls = 0;
  const second = connect((request) =>
    request.url.searchParams.has("since")
      ? (calls++, json({ error: "invalid since cursor" }, 400))
      : json({ events: [], hasMore: false, cursor: "c2" }),
  );
  expect(await run(["message", "check"], second.transport)).toContain(
    "No more new inbox messages.",
  );
  expect(calls).toBe(1);
});

test("a failed message check does not move the cursor", async () => {
  await home.store.writeCursor("p", "old");
  const t = connect(() => json({ error: "boom" }, 500));
  await expect(run(["message", "check"], t.transport)).rejects.toMatchObject({
    code: "SERVER_5XX",
  });
  await t.commit();
  expect(await home.store.readCursor("p")).toBe("old");
});

test("message read, search and resolve map to the server routes and shapes", async () => {
  const id = "22222222-2222-4222-8222-222222222222";
  const t = connect((request) => {
    if (request.url.pathname.endsWith("/messages/search"))
      return json({ results: [message(id, "needle")], hasMore: false });
    if (request.url.pathname.endsWith("/resolve"))
      return json({ message: message(id, "resolved") });
    return json({
      messages: [message(id, "history")],
      hasOlder: false,
      hasNewer: false,
      modelSeenUpToSeq: 1,
    });
  });
  expect(
    await run(["message", "read", "--target", "#general", "--limit", "5"], t.transport),
  ).toContain("history");
  expect(t.requests[0]!.url.searchParams.get("target")).toBe("#general");
  expect(t.requests[0]!.url.searchParams.get("limit")).toBe("5");
  expect(await run(["message", "search", "--query", "needle"], t.transport)).toContain("needle");
  expect(await run(["message", "resolve", id], t.transport)).toContain("resolved");
});

test("message send posts the content and leaves out the daemon's draft options", async () => {
  const t = connect(() =>
    json({ idempotencyKey: "k", state: "sent", decision: "forward", messageId: "m1" }),
  );
  const result = (await t.transport.send("#general", "hello", {})) as { messageId: string };
  expect(result.messageId).toBe("m1");
  const body = JSON.parse(t.requests[0]!.body);
  expect(body).toMatchObject({ target: "#general", content: "hello" });
  expect(t.requests[0]!.method).toBe("POST");
  await expect(t.transport.send("#general", undefined, { sendDraft: true })).rejects.toMatchObject({
    code: "UNSUPPORTED_FOR_EXTERNAL_AGENTS",
  });
});

test("a held send is not sent and tells the Agent what to do", async () => {
  const t = connect(() =>
    json({
      idempotencyKey: "k",
      state: "held",
      decision: "local_hold",
      newMessageCount: 2,
      heldMessages: [message("33333333-3333-4333-8333-333333333333", "newer")],
    }),
  );
  await expect(t.transport.send("#general", "hello", {})).rejects.toMatchObject({
    code: "SEND_HELD",
    contextText: expect.stringContaining("newer"),
  });
});

test("a send that loses its connection reports an unknown delivery", async () => {
  const t = connect(() => {
    throw new Error("offline");
  });
  await expect(t.transport.send("#general", "hello", {})).rejects.toMatchObject({
    code: "SEND_FAILED",
    suggestedNextAction: expect.stringContaining("UNKNOWN"),
  });
});

test("daemon-only commands fail locally before any request", async () => {
  const t = connect(() => json({}));
  for (const call of [
    () => t.transport.githubCredential!(),
    () => t.transport.githubCommitTrailers!(null),
    () => t.transport.contextSearch!({ messageId: "m", sessionId: "s", query: "q" }),
    () => t.transport.continue!("c", "a"),
  ])
    await expect(call()).rejects.toMatchObject({ code: "UNSUPPORTED_FOR_EXTERNAL_AGENTS" });
  expect(t.requests).toEqual([]);
});

test("coforge version in profile mode prints the CLI version without asking a daemon", async () => {
  const t = connect(() => json({}));
  expect(await run(["version"], t.transport)).toMatch(/^CLI: \S+$/);
  expect(t.requests).toEqual([]);
});

test("a server refusal of an unsupported route reads as external-Agent guidance", async () => {
  const t = connect(() =>
    json(
      {
        error: "no",
        code: "unsupported_for_external_agents",
        feature: "weekly-reports",
        retryable: false,
      },
      403,
    ),
  );
  await expect(t.transport.weeklyReport!({ idempotencyKey: "k" } as never)).rejects.toThrow();
  await expect(
    t.transport.task!({ operation: "list", target: "#x" } as never),
  ).rejects.toMatchObject({
    code: "UNSUPPORTED_FOR_EXTERNAL_AGENTS",
    message: "This operation is not available to external Agents (weekly-reports).",
  });
});

test("reminders.schedule gets the scheduler advice, list goes to the server", async () => {
  const t = connect((request) => {
    const body = JSON.parse(request.body);
    return body.operation === "schedule"
      ? json(
          {
            error: "no",
            code: "reminders_unsupported_for_external_agents",
            feature: "reminders.schedule",
          },
          409,
        )
      : json({
          idempotencyKey: body.idempotencyKey,
          workspaceId: "w1",
          computerId: "a1",
          agentId: "a1",
          accepted: true,
          reminders: [],
          events: [],
        });
  });
  await expect(
    run(
      [
        "reminder",
        "schedule",
        "--title",
        "t",
        "--target",
        "#general",
        "--message-id",
        "abcd1234",
        "--delay-seconds",
        "60",
      ],
      t.transport,
    ),
  ).rejects.toMatchObject({
    code: "UNSUPPORTED_FOR_EXTERNAL_AGENTS",
    message: "This operation is not available to external Agents (reminders.schedule).",
    suggestedNextAction:
      "Use your own runtime's scheduler, and say in the thread when you will follow up.",
  });
  await run(["reminder", "list"], t.transport);
  expect(JSON.parse(t.requests.at(-1)!.body)).toMatchObject({
    operation: "list",
    workspaceId: "w1",
    agentId: "a1",
  });
  await expect(
    run(
      ["reminder", "ack", "--id", "11111111-1111-4111-8111-111111111111", "--revision", "1"],
      t.transport,
    ),
  ).rejects.toMatchObject({
    code: "UNSUPPORTED_FOR_EXTERNAL_AGENTS",
  });
});

test("a rejected key renders as a credential problem", async () => {
  const t = connect(() =>
    json({ error: "unauthorized", code: "invalid_credential", retryable: false }, 401),
  );
  await expect(run(["message", "check"], t.transport)).rejects.toMatchObject({
    code: "EXTERNAL_CREDENTIAL_INVALID",
  });
});

test("inbox check in profile mode says App items and seals are not available", async () => {
  const t = connect((request) =>
    request.url.pathname.endsWith("/inbox/conversations")
      ? json({
          ok: true,
          view: "unread",
          items: [],
          totals: { conversations: 0, dms: 0, mentions: 0 },
          hasMore: false,
          nextBefore: null,
        })
      : json({}),
  );
  const output = await run(["inbox", "check"], t.transport);
  expect(output).toContain("not available for external Agents");
});

test("whoami in profile mode reports the external client and confirms it with the server", async () => {
  const t = connect(() =>
    json({
      agent: {
        id: "a1",
        name: "builder",
        displayName: "Builder",
        description: "d",
        role: "member",
        external: true,
      },
      workspace: { id: "w1", slug: "acme", name: "Acme" },
      credential: { id: "c1" },
      capabilities: [],
      prompt: null,
    }),
  );
  const text = await runExternalWhoami(t.session, parseWhoamiArgs([]));
  expect(text).toContain("Client mode: external");
  expect(text).toContain("source=profile");
  expect(text).toContain(`Profile: p (${t.session.path})`);
  expect(text).toContain("Server: confirmed @builder");
  expect(text).not.toContain(OLD_KEY);
  const data = JSON.parse(await runExternalWhoami(t.session, parseWhoamiArgs(["--json"]))).data;
  expect(data).toMatchObject({
    clientMode: "external",
    credentialSource: "profile",
    profile: { slug: "p" },
  });
});

test("whoami names a mismatch when the server's Agent differs", async () => {
  const t = connect(() =>
    json({
      agent: {
        id: "other",
        name: "x",
        displayName: "x",
        description: "",
        role: "",
        external: true,
      },
      workspace: { id: "w1", slug: "acme", name: "A" },
      credential: null,
      capabilities: [],
      prompt: null,
    }),
  );
  await expect(runExternalWhoami(t.session, parseWhoamiArgs([]))).rejects.toMatchObject({
    code: "IDENTITY_MISMATCH",
  });
});

test("whoami --prompt prints the guide, or says there is none", async () => {
  const withPrompt = connect(() =>
    json({ agent: { id: "a1" }, workspace: { slug: "acme" }, prompt: { text: "Be kind." } }),
  );
  expect(await runExternalWhoami(withPrompt.session, parseWhoamiArgs(["--prompt"]))).toBe(
    "Be kind.",
  );
  const without = connect(() =>
    json({ agent: { id: "a1" }, workspace: { slug: "acme" }, prompt: null }),
  );
  await expect(
    runExternalWhoami(without.session, parseWhoamiArgs(["--prompt"])),
  ).rejects.toMatchObject({
    code: "PROMPT_UNAVAILABLE",
    message: "The server has no operating guide for this Agent yet.",
  });
});

test("whoami --prompt for a managed Agent is unavailable without any request", async () => {
  await expect(run(["whoami", "--prompt"], {} as never)).rejects.toMatchObject({
    code: "PROMPT_UNAVAILABLE",
    message: "A managed Agent's instructions come from its daemon.",
  });
});

test("an unconfirmed external whoami still prints what it knows and fails", async () => {
  const t = connect(() => json({}, 503));
  await expect(runExternalWhoami(t.session, parseWhoamiArgs([]))).rejects.toMatchObject({
    code: "WHOAMI_FAILED",
    stdoutText: expect.stringContaining("Client mode: external"),
  });
});
