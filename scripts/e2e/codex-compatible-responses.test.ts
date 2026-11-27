import { expect, test } from "bun:test";
import { startResponsesFixture } from "./codex-compatible-responses";
import { verifyBlockedEgress } from "./codex-compatible-egress";

test("the fixture streams its reply only for the matching Responses call", async () => {
  const apiKey = `fixture-${crypto.randomUUID()}`;
  const unrelatedKey = `fixture-${crypto.randomUUID()}`;
  const model = "gpt-5.4";
  const reply = `CODEX_E2E_${crypto.randomUUID()}`;
  const fixture = startResponsesFixture({ apiKey, model, reply });

  async function send(path: string, key?: string, requestedModel = model) {
    return fetch(new URL(path, fixture.baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({ model: requestedModel, stream: true }),
    });
  }

  try {
    const responses = await Promise.all([
      send("/v1/responses"),
      send("/v1/responses", unrelatedKey),
      send(`/v1/${unrelatedKey}`, apiKey),
      send("/v1/responses", apiKey, unrelatedKey),
    ]);
    expect(responses.map(({ status }) => status)).toEqual([401, 401, 404, 400]);

    const response = await send("/v1/responses", apiKey);
    expect(response.ok).toBe(true);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const body = await response.text();
    expect(body).toContain("event: response.completed");
    expect(body).toContain(reply);
    expect(fixture.requests.filter((request) => request.status === 200)).toEqual([
      {
        method: "POST",
        path: "/v1/responses",
        model,
        bearerMatched: true,
        traceId: expect.any(String),
        status: 200,
      },
    ]);

    const refusals = await Promise.all(responses.map((refusal) => refusal.text()));
    const evidence = JSON.stringify({ requests: fixture.requests, refusals, body });
    expect(evidence.includes(apiKey) || evidence.includes(unrelatedKey)).toBe(false);
  } finally {
    await fixture.stop();
  }
});

test("both named and direct-IP egress must be blocked before a run", async () => {
  const attempted: string[] = [];
  const blocked = async (url: string) => {
    attempted.push(url);
    throw new TypeError("connection blocked");
  };
  expect(await verifyBlockedEgress(blocked)).toEqual({
    hostnameBlocked: true,
    directIpBlocked: true,
  });
  expect(attempted.map((url) => new URL(url).hostname)).toEqual(["example.com", "1.1.1.1"]);
  const reachable = async () => new Response(null, { status: 403 });
  await expect(verifyBlockedEgress(reachable)).rejects.toThrow("External egress was reachable");
});
