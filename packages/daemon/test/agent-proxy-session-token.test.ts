import { afterEach, expect, test } from "bun:test";
import { agentApiRoutes } from "@lrm/coforge-sdk/agent";
import { startAgentProxy } from "#src/agent-proxy";
import { agentSessionIsLive } from "#src/agent-proxy-session-admission";
import { SESSION_NOT_RUNNING_CODE } from "#src/agent-proxy-tokens";
import { revokeLocalLaunch } from "#src/daemon-runtime/agent-launch-revocation";
import { AgentStopRegistry } from "#src/daemon-runtime/agent-stop-registry";
import { abandonLaunch } from "#src/daemon-runtime/agent-startup-failure";
import type { ActivityLaunch } from "#src/daemon-runtime/activity-launch";

const proxies: Array<{ close(): void }> = [];
afterEach(() => {
  for (const proxy of proxies.splice(0)) proxy.close();
});

const KEY_A = `sk_agent_${"a".repeat(43)}`;
const KEY_B = `sk_agent_${"b".repeat(43)}`;
const LIST = {
  ok: true as const,
  view: "unread" as const,
  items: [],
  totals: { conversations: 0, dms: 0, mentions: 0 },
  hasMore: false,
  nextBefore: null,
};

function start(running: { value: boolean }, isLive?: (agentId: string) => boolean) {
  const keys = new Map<string, string>();
  const seenKeys: Array<string | undefined> = [];
  const proxy = startAgentProxy({
    runtime: {
      agentMessage: async () => ({}),
      issueAgentContext: (agentId: string) => agentId,
      isAgentSessionRunning: isLive ?? (() => running.value),
      inboxList: async (_context, _request, agentApiKey) => {
        seenKeys.push(agentApiKey);
        return LIST;
      },
    },
    agentApiKeys: {
      get: (agentId) => keys.get(agentId),
      set: (agentId, key) => void keys.set(agentId, key),
    },
  });
  proxies.push(proxy);
  return { proxy, keys, seenKeys };
}

function ask(proxy: { url: string }, token: string) {
  return fetch(
    proxy.url.replace(agentApiRoutes.proxy.messages.path, agentApiRoutes.proxy.inboxList.path),
    { headers: { authorization: `Bearer ${token}` } },
  );
}

test("one Agent keeps one token: a later launch reuses it, another Agent gets its own", async () => {
  const { proxy } = start({ value: true });
  const first = proxy.issue("agent-a", KEY_A);
  const second = proxy.issue("agent-a", KEY_B);
  expect(second).toBe(first);
  expect(proxy.issue("agent-b", KEY_A)).not.toBe(first);
});

test("a session that ended and came back keeps the same token", async () => {
  const running = { value: true };
  const { proxy, keys } = start(running);
  const token = proxy.issue("agent-a", KEY_A);
  // The session exits: its key goes, the token stays registered.
  running.value = false;
  keys.delete("agent-a");
  expect((await ask(proxy, token)).status).toBe(409);
  // The next launch mints a key and reuses the token.
  running.value = true;
  expect(proxy.issue("agent-a", KEY_B)).toBe(token);
  expect((await ask(proxy, token)).status).toBe(200);
});

test("a token with no running session is refused with 409 and a readable reason, never 401", async () => {
  const running = { value: true };
  const { proxy } = start(running);
  const token = proxy.issue("agent-a", KEY_A);
  expect((await ask(proxy, token)).status).toBe(200);
  running.value = false;
  const response = await ask(proxy, token);
  expect(response.status).toBe(409);
  const body = (await response.json()) as { code: string; error: string };
  expect(body.code).toBe(SESSION_NOT_RUNNING_CODE);
  expect(body.error.length).toBeGreaterThan(20);
  running.value = true;
  expect((await ask(proxy, token)).status).toBe(200);
});

test("a revoked Agent's token is 401 for good, and issuing again gives a new token", async () => {
  const { proxy } = start({ value: true });
  const first = proxy.issue("agent-a", KEY_A);
  proxy.revokeAgent!("agent-a");
  expect((await ask(proxy, first)).status).toBe(401);
  const again = proxy.issue("agent-a", KEY_A);
  expect(again).not.toBe(first);
  expect((await ask(proxy, first)).status).toBe(401);
  expect((await ask(proxy, again)).status).toBe(200);
});

test("after a Stop and an immediate restart the old token stays 401", async () => {
  const { proxy } = start({ value: true });
  const first = proxy.issue("agent-a", KEY_A);
  // The daemon's Stop path: the bare revoke drops the Agent's whole registration.
  proxy.revokeAgent!("agent-a");
  const restarted = proxy.issue("agent-a", KEY_B);
  expect(restarted).not.toBe(first);
  expect((await ask(proxy, first)).status).toBe(401);
  expect((await ask(proxy, restarted)).status).toBe(200);
});

test("an Agent's token never opens another Agent's session state", async () => {
  const running = { value: true };
  const { proxy, seenKeys } = start(running);
  const a = proxy.issue("agent-a", KEY_A);
  proxy.issue("agent-b", KEY_B);
  await ask(proxy, a);
  expect(seenKeys).toEqual([KEY_A]);
});

test("a key that is gone answers 409, not a server error", async () => {
  const { proxy, keys } = start({ value: true });
  const token = proxy.issue("agent-a", KEY_A);
  keys.delete("agent-a");
  const response = await ask(proxy, token);
  expect(response.status).toBe(409);
  expect(((await response.json()) as { code: string }).code).toBe(SESSION_NOT_RUNNING_CODE);
});

test("a new proxy does not know a token an earlier one issued", async () => {
  const first = start({ value: true });
  const token = first.proxy.issue("agent-a", KEY_A);
  const second = start({ value: true });
  expect((await ask(second.proxy, token)).status).toBe(401);
});

test("a launch the daemon abandoned leaves its token answering 409, not 401", async () => {
  const launch: ActivityLaunch = { launchId: "launch-1", clientSeq: 1, stopping: false };
  const launches = new Map<string, ActivityLaunch>([["agent-a", launch]]);
  const { proxy } = start({ value: false }, () =>
    agentSessionIsLive(
      { isRunning: () => false, launch: (agentId) => launches.get(agentId) },
      "agent-a",
    ),
  );
  const token = proxy.issue("agent-a", KEY_A);
  expect((await ask(proxy, token)).status).toBe(200);

  await abandonLaunch(
    {
      stopping: false,
      stops: new AgentStopRegistry(),
      inputDrain: { close: () => {} },
      currentActivityLaunches: launches,
      interruptIfBusy: () => {},
      activityPublisher: { forgetBusy: () => {}, publish: () => {} },
      disposeLaunchObservations: () => {},
      offlineResidency: { record: () => undefined, remember: () => {} },
      stopCoordinator: { releaseAgentRuntime: async () => {} },
      drafts: {
        runtimeError: () => ({
          protocolMajor: 1,
          requestId: "request-1",
          workspaceId: "w",
          agentId: "agent-a",
          detail: "",
          detailKind: "runtime_error",
          level: "error",
        }),
      },
      agentControl: { stopped: async () => {} },
    },
    "agent-a",
    new Error("startup timed out"),
  );

  expect(launch.stopping).toBe(true);
  const response = await ask(proxy, token);
  expect(response.status).toBe(409);
  expect(((await response.json()) as { code: string }).code).toBe(SESSION_NOT_RUNNING_CODE);
});

test("deleting an Agent drops its registration, so the old token is 401", async () => {
  const { proxy } = start({ value: true });
  const token = proxy.issue("agent-a", KEY_A);
  expect((await ask(proxy, token)).status).toBe(200);

  const contexts = new Map([["agent-a", "context-1"]]);
  const tokens = new Map([["agent-a", token]]);
  revokeLocalLaunch(contexts, tokens, proxy, "agent-a");

  expect(tokens.size).toBe(0);
  expect((await ask(proxy, token)).status).toBe(401);
});
