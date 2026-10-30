import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { agentApiRoutes } from "@lrm/coforge-sdk/agent";
import { connectLocal } from "#src/local-client";
import { type CliError, renderCliErrorText } from "#src/cli-error";

const context = `sfp_${"a".repeat(43)}`;

const proxyUrl = (route: { path: string } | string) =>
  `http://proxy.test${typeof route === "string" ? route : route.path}`;

afterEach(() => {
  mock.restore();
});

/** What `githubCredential` threw against a proxy that answered (or failed) as `fetch` does. */
const githubCredentialFailure = () =>
  connectLocal("", context, proxyUrl(agentApiRoutes.local.messages)).githubCredential!().then(
    () => Promise.reject(new Error("the request was expected to fail")),
    (thrown: unknown) => thrown as CliError,
  );

/** The daemon's answer for an upstream 5xx: the cloud's named code (`causeCode`), or its own
 * `agent_proxy_failed` when the cloud named none. */
const upstream5xx = (code: string, causeCode: string) =>
  Response.json(
    {
      error:
        code === "agent_proxy_failed"
          ? "upstream HTTP response failed"
          : "the server is temporarily unavailable; retry",
      code,
      proxy: {
        correlation_id: "corr-unavailable",
        route_family: "agent-api/github-credentials",
        failure_class: "upstream_http_response",
        cause_code: causeCode,
        upstream_status: 503,
        response_started: true,
        response_complete: true,
      },
    },
    { status: 503 },
  );

test("a GitHub credential the cloud cannot issue right now is retryable: the lookup changes nothing", async () => {
  spyOn(globalThis, "fetch").mockResolvedValue(
    upstream5xx("TEMPORARILY_UNAVAILABLE", "TEMPORARILY_UNAVAILABLE"),
  );

  const error = await githubCredentialFailure();
  const text = renderCliErrorText(error);

  // The server named its reason: the CLI reports that code, not the generic SERVER_5XX.
  expect(error).toMatchObject({
    code: "TEMPORARILY_UNAVAILABLE",
    message: "the server is temporarily unavailable; retry",
    retryable: true,
    correlationId: "corr-unavailable",
    proxy: { upstreamStatus: 503 },
  });
  expect(text).toContain("Code: TEMPORARILY_UNAVAILABLE");
  expect(text).toContain("Retryable: yes");
  expect(text).toContain("Correlation: corr-unavailable");
});

test("a GitHub credential lookup that failed with a bare upstream 5xx is retryable", async () => {
  spyOn(globalThis, "fetch").mockResolvedValue(upstream5xx("agent_proxy_failed", "HTTP_503"));

  expect(await githubCredentialFailure()).toMatchObject({ code: "SERVER_5XX", retryable: true });
});
