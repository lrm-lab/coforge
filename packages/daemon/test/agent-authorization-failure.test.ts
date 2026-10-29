import { describe, expect, test } from "bun:test";
import {
  AgentConfigRequestError,
  type AgentConfigFailure,
} from "#src/connection/agent-config-request";
import { AgentAuthorizationError, launchFailureActivity } from "#src/agent-runtime/launch-failure";

/** The launch failure an Agent's Activity shows for a configuration request that failed. */
const explain = (failure: AgentConfigFailure, status?: number, code?: string) =>
  launchFailureActivity(
    new AgentAuthorizationError(
      new AgentConfigRequestError(failure, status, code, "Agent launch config request failed"),
    ),
    "Codex",
  ).detail;

describe("explaining a launch that could not get its configuration", () => {
  test("a network failure says the server could not be reached, and does not mention versions", () => {
    const detail = explain("network");
    expect(detail).toContain("could not reach the server");
    expect(detail).toContain("retried");
    expect(detail).not.toContain("upgrade");
  });

  test("a busy server reads as transient, not as the Computer's fault", () => {
    const detail = explain("server", 503);
    expect(detail).toContain("did not answer reliably");
    expect(detail).not.toContain("coforge-computer upgrade");
  });

  test("a refusal sends the reader to the Computer's connection, not its version", () => {
    const detail = explain("refused", 403);
    expect(detail).toContain("the server refused this Computer's request");
    expect(detail).toContain("still connected to the Workspace");
    expect(detail).not.toContain("coforge-computer upgrade");
  });

  test("only a refusal that names the version suggests an upgrade", () => {
    expect(explain("refused", 403, "version_unsupported")).toContain("`coforge-computer upgrade`");
  });

  test("the reason code stays the one launch authorization reason", () => {
    expect(
      launchFailureActivity(new AgentAuthorizationError(new Error("boom")), "Codex"),
    ).toMatchObject({ runtimeError: { errorReason: "agent_authorization_failed" } });
  });

  test("an unclassified failure keeps a neutral explanation", () => {
    const detail = launchFailureActivity(
      new AgentAuthorizationError(new Error("something else")),
      "Codex",
    ).detail;
    expect(detail).toContain("could not obtain the Agent's launch credentials");
    expect(detail).not.toContain("upgrade");
  });
});
