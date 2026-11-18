import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { agentApiRoutes } from "@lrm/coforge-sdk/agent";
import { connectLocal } from "#src/local-client";
import { type CliError, renderCliErrorText } from "#src/cli-error";

const context = `sfp_${"a".repeat(43)}`;
const proxyUrl = `http://proxy.test${agentApiRoutes.proxy.messages.path}`;
const MESSAGE =
  "This Agent has no running session right now, so the request was not sent. Call again once the Agent is running.";

afterEach(() => {
  mock.restore();
});

/** The daemon refuses before forwarding when the Agent has no session: the CLI must print that
 * sentence and the session code, not a generic failure (task #runtime-optimization:#23). */
test("a 409 from the local proxy prints the readable reason and the session code", async () => {
  spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json(
      {
        error: MESSAGE,
        code: "agent_session_not_running",
        retryable: false,
        proxy: {
          layer: "local_daemon_proxy",
          correlation_id: "corr-session",
          route_family: "agent-api/session",
          failure_class: "local_precondition",
          cause_code: "agent_session_not_running",
          response_started: false,
          response_complete: false,
        },
      },
      { status: 409 },
    ),
  );

  const error = await connectLocal("", context, proxyUrl)
    .check("dm:@ada")
    .then(
      () => Promise.reject(new Error("the request was expected to fail")),
      (thrown: unknown) => thrown as CliError,
    );

  expect(error.message).toBe(MESSAGE);
  expect(error.code).toBe("agent_session_not_running");
  expect(error.retryable).toBe(false);
  expect(renderCliErrorText(error)).toContain(MESSAGE);
});
