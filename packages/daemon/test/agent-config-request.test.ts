import { describe, expect, test } from "bun:test";
import {
  AGENT_CONFIG_RETRY_DELAYS_MS,
  AgentConfigRequestError,
  requestAgentConfig,
  retryableAgentConfigFailure,
} from "#src/connection/agent-config-request";

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
    expect((calls[0]!.init?.headers as Record<string, string>).authorization).toBe(
      "Bearer daemon-token",
    );
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
