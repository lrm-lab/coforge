import { expect, test } from "bun:test";
import { AgentStopRegistry } from "#src/daemon-runtime/agent-stop-registry";
import { abandonLaunch } from "#src/daemon-runtime/agent-startup-failure";
import { resolveLaunchIdentity } from "#src/daemon-runtime/launch-identity";

/**
 * An abandoned launch is teardown, not a person's Stop: it must leave the Agent marked stopping
 * for the cleanup window but keep the Session the launch reported, so the next daemon-initiated
 * wake resumes that native Session instead of starting a new one (task #372 review).
 */
test("an abandoned launch keeps the Session the next wake resumes", async () => {
  const registry = new AgentStopRegistry();
  registry.rememberSession("a", { requestId: "req-1", provider: "kiro", sessionId: "sess-1" });

  const outcome = await abandonLaunch(
    {
      stopping: false,
      stops: registry,
      inputDrain: { close: () => {} },
      currentActivityLaunches: new Map(),
      interruptIfBusy: () => {},
      activityPublisher: { forgetBusy: () => {}, publish: () => {} },
      disposeLaunchObservations: () => {},
      revokeLocalLaunch: () => {},
      offlineResidency: { record: () => undefined, remember: () => {} },
      stopCoordinator: { releaseAgentRuntime: async () => {} },
      drafts: {
        runtimeError: () => ({
          protocolMajor: 1,
          requestId: "req-1",
          workspaceId: "w",
          agentId: "a",
          detail: "",
          detailKind: "runtime_error",
          level: "error",
        }),
      },
      agentControl: { stopped: async () => {} },
    },
    "a",
    new Error("startup timed out"),
  );
  expect(outcome).toBeInstanceOf(Error);

  // The cleanup settled, so the Agent is no longer stopping, and its Session record survived.
  expect(registry.stopping("a")).toBe(false);
  expect(registry.sessionReference("a")?.sessionId).toBe("sess-1");

  // What a wake does next: the remembered Session is the `previous` it continues from.
  const identity = resolveLaunchIdentity({
    request: {},
    provider: "kiro",
    previous: registry.sessionReference("a"),
    serverLaunch: undefined,
  });
  expect(identity.reference.sessionId).toBe("sess-1");
  expect(identity.reference.requestId).toBe("req-1");
});
