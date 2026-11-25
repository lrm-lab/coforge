import { describe, expect, spyOn, test } from "bun:test";
import { requestAgentLaunchConfig } from "#src/connection/agent-api-key-requests";
import {
  AGENT_CONFIG_RETRY_DELAYS_MS,
  AgentConfigRequestError,
  requestAgentConfig,
  retryableAgentConfigFailure,
} from "#src/connection/agent-config-request";

import { parseAgentLaunchConfig } from "#src/connection/agent-launch-response";

const base = {
  what: "Agent launch config",
  method: "POST" as const,
  token: "daemon-token",
  body: "{}",
  sleep: async () => {},
  url: "https://server.example/api/agent-api-keys",
};

/** A fetch that answers from `answers` in order, repeating the last one. */
function scripted(answers: (() => Promise<Response>)[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  let index = 0;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return answers[Math.min(index++, answers.length - 1)]!();
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const ok = () => Promise.resolve(Response.json({ apiKey: "sk_agent_x" }));
const status =
  (code: number, body: unknown = {}) =>
  () =>
    Promise.resolve(Response.json(body, { status: code }));
const networkError = () => Promise.reject(new Error("connect ECONNREFUSED"));

describe("obtaining the Agent launch configuration", () => {
  test("a 200 answers once", async () => {
    const { fetchImpl, calls } = scripted([ok]);
    const response = await requestAgentConfig({ ...base, fetchImpl });
    expect(response.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init?.method).toBe("POST");
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe("Bearer daemon-token");
  });

  test("a dropped connection is retried three times in all, then reported as network", async () => {
    const { fetchImpl, calls } = scripted([networkError]);
    const failure = await requestAgentConfig({ ...base, fetchImpl }).catch((e: unknown) => e);
    expect(calls).toHaveLength(AGENT_CONFIG_RETRY_DELAYS_MS.length + 1);
    expect(failure).toBeInstanceOf(AgentConfigRequestError);
    expect(failure).toMatchObject({ failure: "network", status: undefined });
    expect(retryableAgentConfigFailure(failure)).toBe(true);
  });

  test("a busy server (503, 429, 408) is retried and can still land", async () => {
    for (const code of [503, 429, 408]) {
      const { fetchImpl, calls } = scripted([status(code), ok]);
      const response = await requestAgentConfig({ ...base, fetchImpl });
      expect(response.ok).toBe(true);
      expect(calls).toHaveLength(2);
    }
  });

  test("a refusal is the server's answer, sent once, carrying its own code", async () => {
    const { fetchImpl, calls } = scripted([
      status(403, { error: "forbidden", code: "version_unsupported" }),
    ]);
    const failure = await requestAgentConfig({ ...base, fetchImpl }).catch((e: unknown) => e);
    expect(calls).toHaveLength(1);
    expect(failure).toMatchObject({
      failure: "refused",
      status: 403,
      upstreamCode: "version_unsupported",
    });
    expect(retryableAgentConfigFailure(failure)).toBe(false);
    expect((failure as Error).message).toContain("(403)");
  });

  test("a 500 is transient, and says the server failed rather than refusing", async () => {
    const { fetchImpl, calls } = scripted([status(500)]);
    const failure = await requestAgentConfig({ ...base, fetchImpl }).catch((e: unknown) => e);
    expect(calls).toHaveLength(AGENT_CONFIG_RETRY_DELAYS_MS.length + 1);
    expect(failure).toMatchObject({ failure: "server", status: 500 });
    expect(retryableAgentConfigFailure(failure)).toBe(true);
  });

  test("each failed attempt is logged with its status, code and retryability", async () => {
    const { captureDaemonLogs } = await import("./log-capture");
    const { fetchImpl } = scripted([status(503)]);
    const { records } = await captureDaemonLogs(() =>
      requestAgentConfig({ ...base, fetchImpl }).catch(() => undefined),
    );
    const logged = records.filter(
      (record) => record.properties.event === "agent_launch_config:request_failed",
    );
    expect(logged).toHaveLength(3);
    expect(logged[0]!.properties).toMatchObject({
      what: "Agent launch config",
      attempt: 1,
      failure: "server",
      http_status: 503,
      retryable: true,
    });
  });

  test("every launch config HTTP attempt has a distinct correlation ID logged with its status", async () => {
    const { captureDaemonLogs } = await import("./log-capture");
    const { fetchImpl, calls } = scripted([status(503), ok]);
    const launch = { agentId: "fixture-agent", launchId: crypto.randomUUID() };
    const { records, result } = await captureDaemonLogs(() =>
      requestAgentConfig({ ...base, launch, fetchImpl }),
    );
    expect(result.status).toBe(200);
    const requestIds = calls.map(({ init }) => new Headers(init?.headers).get("x-request-id"));
    expect(requestIds).toHaveLength(2);
    expect(requestIds[0]).toMatch(/^[\da-f-]{36}$/i);
    expect(requestIds[1]).toMatch(/^[\da-f-]{36}$/i);
    expect(requestIds[1]).not.toBe(requestIds[0]);
    const entries = records.map(({ properties }) => properties);
    expect(entries).toContainEqual(
      expect.objectContaining({
        event: "agent_launch_config:request_failed",
        attempt: 1,
        http_status: 503,
        request_id: requestIds[0],
      }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        event: "agent_launch_config:request_succeeded",
        attempt: 2,
        http_status: 200,
        request_id: requestIds[1],
        agent_id: launch.agentId,
        launch_digest: Bun.CryptoHasher.hash("sha256", launch.launchId, "hex"),
      }),
    );
    expect(JSON.stringify(entries)).not.toContain(base.token);
  });

  test("a launch config can receive HTTP 200 yet fail to decode without retrying", async () => {
    const { captureDaemonLogs } = await import("./log-capture");
    const fixture = scripted([status(200, { apiKey: "invalid-payload-marker" })]);
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(fixture.fetchImpl);
    try {
      const { records } = await captureDaemonLogs(async () => {
        await expect(
          requestAgentLaunchConfig(
            { url: () => base.url, token: () => base.token },
            { agentId: "fixture-agent", workspaceId: "fixture-workspace" },
          ),
        ).rejects.toThrow();
      });
      expect(fixture.calls).toHaveLength(1);
      const requestId = new Headers(fixture.calls[0]?.init?.headers).get("x-request-id");
      const entries = records.map(({ properties }) => properties);
      expect(entries).toContainEqual(
        expect.objectContaining({
          event: "agent_launch_config:request_succeeded",
          http_status: 200,
          request_id: requestId,
          agent_id: "fixture-agent",
        }),
      );
      expect(entries[0]?.launch_digest).toBeUndefined();
      expect(JSON.stringify(entries)).not.toContain("invalid-payload-marker");
    } finally {
      fetchMock.mockRestore();
    }
  });

  test("the endpoint is resolved per attempt, so a reconnect is used", async () => {
    const urls: string[] = [];
    let attempt = 0;
    await requestAgentConfig({
      ...base,
      url: () => {
        attempt++;
        return `https://server-${attempt}.example/api/agent-api-keys`;
      },
      fetchImpl: (async (url: string | URL | Request) => {
        urls.push(String(url));
        if (urls.length === 1) throw new Error("socket closed");
        return Response.json({ apiKey: "sk_agent_x" });
      }) as unknown as typeof fetch,
    });
    expect(urls).toEqual([
      "https://server-1.example/api/agent-api-keys",
      "https://server-2.example/api/agent-api-keys",
    ]);
  });
});

test("launch config keeps zero and valid revisions, and ignores absent or malformed proof", () => {
  const apiKey = `sk_agent_${"a".repeat(43)}`;
  const envVars = { CODEX_HOME: "/fixture/home" };
  for (const revision of [0, 9, 2 ** 32 - 1])
    expect(parseAgentLaunchConfig({ apiKey, envVars, runtimeConfigRevision: revision })).toEqual({
      agentApiKey: apiKey,
      envVars,
      runtimeConfigRevision: revision,
    });
  for (const revision of [undefined, null, "9", -1, 3.5, 2 ** 32])
    expect(parseAgentLaunchConfig({ apiKey, envVars, runtimeConfigRevision: revision })).toEqual({
      agentApiKey: apiKey,
      envVars,
    });
});
