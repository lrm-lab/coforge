import { expect, test } from "bun:test";
import {
  agentHeaders,
  setAgentApiKeyHealer,
  withAgentApiKeyHeal,
} from "#src/connection/agent-http-wire";
import type { HttpFetch } from "#src/connection/agent-http-wire";

const KEYS = { agentApiKey: "sk_agent_old", daemonApiKey: "dk_test" };
const INPUT = {
  url: "https://cloud.test/api/agent/v1/messages",
  agentApiKey: KEYS.agentApiKey,
  daemonApiKey: KEYS.daemonApiKey,
  request: {} as never,
};

function init() {
  return {
    method: "POST",
    headers: agentHeaders(KEYS, true),
    body: JSON.stringify({ text: "hi" }),
  };
}

function stubFetch(responses: Response[]) {
  const calls: { headers: Headers; body?: RequestInit["body"] }[] = [];
  const fetcher: HttpFetch = async (_input, i) => {
    calls.push({ headers: new Headers(i?.headers), body: i?.body });
    return responses[calls.length - 1] ?? new Response(null, { status: 500 });
  };
  return { calls, fetcher };
}

function installHealer(healer: (key: string) => Promise<string | undefined>) {
  setAgentApiKeyHealer(healer);
  return () => setAgentApiKeyHealer(undefined);
}

test("a 401 carrying an Agent key heals once and retries with the fresh key", async () => {
  const { calls, fetcher } = stubFetch([
    new Response("unauthorized", { status: 401 }),
    Response.json({ ok: true }, { status: 200 }),
  ]);
  const seen: string[] = [];
  const uninstall = installHealer(async (key) => {
    seen.push(key);
    return "sk_agent_new";
  });
  try {
    const wrapped = withAgentApiKeyHeal(fetcher);
    const res = await wrapped(INPUT.url, init());
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(seen).toEqual(["sk_agent_old"]);
    expect(calls[0]!.headers.get("x-coforge-agent-api-key")).toBe("Bearer sk_agent_old");
    expect(calls[1]!.headers.get("x-coforge-agent-api-key")).toBe("Bearer sk_agent_new");
    // The replayed body is the same bytes, not a consumed stream.
    expect(calls[1]!.body).toBe(calls[0]!.body);
  } finally {
    uninstall();
  }
});

test("a healer answering undefined leaves the 401 untouched", async () => {
  const { calls, fetcher } = stubFetch([new Response("unauthorized", { status: 401 })]);
  const uninstall = installHealer(async () => undefined);
  try {
    const res = await withAgentApiKeyHeal(fetcher)(INPUT.url, init());
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(1);
  } finally {
    uninstall();
  }
});

test("no healer, no agent key, and non-401s pass through without a second call", async () => {
  const { calls, fetcher } = stubFetch([new Response("unauthorized", { status: 401 })]);
  const res = await withAgentApiKeyHeal(fetcher)(INPUT.url, init());
  expect(res.status).toBe(401);
  expect(calls).toHaveLength(1);

  const { calls: calls2, fetcher: fetcher2 } = stubFetch([
    Response.json({ ok: true }, { status: 200 }),
  ]);
  const res2 = await withAgentApiKeyHeal(fetcher2)(INPUT.url, init());
  expect(res2.status).toBe(200);
  expect(calls2).toHaveLength(1);

  // A daemon-key-only request 401s through untouched even with a healer installed.
  const { calls: calls3, fetcher: fetcher3 } = stubFetch([
    new Response("unauthorized", { status: 401 }),
  ]);
  const uninstall = installHealer(async () => "sk_agent_new");
  try {
    const daemonOnly = {
      method: "POST",
      headers: { authorization: `Bearer ${KEYS.daemonApiKey}` },
    };
    const res3 = await withAgentApiKeyHeal(fetcher3)(INPUT.url, daemonOnly);
    expect(res3.status).toBe(401);
    expect(calls3).toHaveLength(1);
  } finally {
    uninstall();
  }
});

test("a stream body cannot be replayed, so the 401 is left alone", async () => {
  const { calls, fetcher } = stubFetch([new Response("unauthorized", { status: 401 })]);
  const uninstall = installHealer(async () => "sk_agent_new");
  try {
    const streamInit = { ...init(), body: new ReadableStream() };
    const res = await withAgentApiKeyHeal(fetcher)(INPUT.url, streamInit);
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(1);
  } finally {
    uninstall();
  }
});
