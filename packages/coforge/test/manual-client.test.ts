import { afterEach, expect, mock, spyOn, test } from "bun:test";
import {
  agentApiRoutes,
  type AgentManualGetResponse,
  type AgentManualSearchResponse,
} from "@lrm/coforge-sdk/agent";
import { connectLocal } from "#src/local-client";
import { CliError, renderCliErrorText } from "#src/cli-error";

const context = `sfp_${"a".repeat(43)}`;
const proxy = "http://proxy.test/api/agent/v1/messages?stale=1";
const input = "任务 & github/docs";
const intent = "Read the requested documentation";
const reason = "Verify the current task workflow";
const client = () => connectLocal("", context, proxy);

afterEach(() => mock.restore());

const routes = [
  {
    name: "get",
    path: agentApiRoutes.manual.get.path,
    parameter: "topic",
    invoke: (transport: ReturnType<typeof client>) => transport.manualGet!(input, intent, reason),
    response: {
      ok: true,
      docId: "github",
      topicOrPath: input,
      docVersion: "abc123",
      docState: "published",
      contentType: "text/markdown",
      content: "# GitHub\n",
    } satisfies AgentManualGetResponse,
  },
  {
    name: "search",
    path: agentApiRoutes.manual.search.path,
    parameter: "query",
    invoke: (transport: ReturnType<typeof client>) =>
      transport.manualSearch!(input, intent, reason),
    response: {
      ok: true,
      query: input,
      scope: null,
      results: [],
    } satisfies AgentManualSearchResponse,
  },
];

for (const route of routes) {
  test(`manual ${route.name} preserves its authenticated GET and decoded result`, async () => {
    const fetch = spyOn(globalThis, "fetch").mockResolvedValue(Response.json(route.response));
    const timeout = spyOn(AbortSignal, "timeout");
    expect(await route.invoke(client())).toEqual(route.response);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [endpoint, init] = fetch.mock.calls[0]!;
    const url = new URL(String(endpoint));
    expect(url.origin + url.pathname).toBe(`http://proxy.test${route.path}`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      [route.parameter]: input,
      intent,
      reason,
    });
    expect(init?.method).toBe("GET");
    expect(init?.headers).toEqual({ authorization: `Bearer ${context}` });
    expect(init?.body).toBeUndefined();
    expect(timeout).toHaveBeenCalledWith(10_000);
    expect(timeout.mock.results[0]?.value).toBe(init?.signal);
  });

  test(`manual ${route.name} keeps domain errors and only offers index guidance for a missing topic`, async () => {
    const fetch = spyOn(globalThis, "fetch");
    for (const errorCode of ["knowledge_not_found", "knowledge_query_invalid"]) {
      fetch.mockResolvedValueOnce(
        Response.json({ ok: false, errorCode, error: "" }, { status: 404 }),
      );
      const error = await route.invoke(client()).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(CliError);
      const failure = error as CliError;
      expect(failure.code).toBe(errorCode.toUpperCase());
      expect(failure.message).toBe("");
      expect(failure.retryable).toBe(false);
      if (errorCode === "knowledge_not_found")
        expect(renderCliErrorText(failure)).toContain("coforge manual get index");
      else expect(failure.suggestedNextAction).toBeUndefined();
    }
  });

  test(`manual ${route.name} rejects malformed success and falls back for non-domain failures`, async () => {
    const fetch = spyOn(globalThis, "fetch");
    fetch.mockResolvedValueOnce(new Response("not json", { status: 200 }));
    await expect(route.invoke(client())).rejects.toThrow(
      `invalid Agent Manual ${route.name} response`,
    );
    fetch.mockResolvedValueOnce(new Response("not json", { status: 502 }));
    await expect(route.invoke(client())).rejects.toMatchObject({
      code: "MANUAL_FAILED",
      message: "HTTP 502",
      retryable: false,
      suggestedNextAction: undefined,
    });
    fetch.mockRejectedValueOnce(new Error("network failure"));
    await expect(route.invoke(client())).rejects.toMatchObject({
      code: "MANUAL_FAILED",
      message: "agent proxy request failed (network or timeout)",
      retryable: false,
    });
  });

  test(`manual ${route.name} refuses an invalid local context before issuing a request`, async () => {
    const fetch = spyOn(globalThis, "fetch");
    await expect(route.invoke(connectLocal("", "invalid", proxy))).rejects.toMatchObject({
      code: "MANUAL_FAILED",
      retryable: false,
    });
    expect(fetch).not.toHaveBeenCalled();
  });
}
