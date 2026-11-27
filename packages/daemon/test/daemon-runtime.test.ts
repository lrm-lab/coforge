import { sessionSpy } from "./fixtures/session-spy";
import {
  AGENT_MIGRATION_CAPABILITY,
  APP_CONFIG_CAPABILITY,
  APP_CONFIG_SYNC_MESSAGE_TYPE,
  CLEANER_APP_ID,
  REMINDER_DUE_MESSAGE_TYPE,
  type ReminderDue,
  type ReminderJob,
} from "@lrm/coforge-sdk/internal";
import type { AgentMigrationServer } from "#src/agent-migration/transfer-ports";
import type { ReceivedAgentMigrationLease } from "#src/connection/daemon-connection-client";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  setSystemTime,
  test,
} from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { DaemonRuntime, USAGE_SCAN_READ_TIMEOUT_MS } from "#src/daemon-runtime/runtime";
import { ACTIVITY_HEARTBEAT_MS } from "#src/daemon-runtime/agent-activity-publisher";
import { claudeProvider, claudeUsageFixture } from "./fixtures/claude-provider";
import { RUNTIME_ERROR_DELIVERY_BACKOFF_BASE_MS } from "#src/agent-runtime/runtime-error-recovery";
import { RuntimeExecutableNotFoundError } from "#src/platform/runtime-executable-not-found";
import { DaemonConnectionStoppedError } from "#src/connection/daemon-connection-stopped-error";
import {
  AGENT_RUNTIME_EVENT_TYPE,
  AgentProcessCleanupError,
  AgentSessionRecoveryError,
  AgentEnvironmentError,
  ModelProviderSettingError,
  RuntimeModelNotFoundError,
  RuntimeVersionUnsupportedError,
  UsageUnavailableError,
  type AgentRuntimeConfig,
  type AgentRuntimeEvent,
  type CodeAgentProvider,
  type AgentSession,
} from "@lrm/coforge-anvil";
import type { DaemonConfig } from "#src/daemon-runtime/runtime";
import { InMemoryDaemonCredentialStore } from "#src/credentials/credential-store";
import { seedCursor, seedReviewedDelivery } from "./fixtures/consumed-cursor";
import type {
  AgentMessageTransportResponse,
  AgentSendReconciliationRequest,
} from "#src/connection/agent-http-clients";
import type { AgentSendReconciliationResponse } from "@lrm/coforge-sdk/agent";
import { DaemonConnection } from "#src/connection/daemon-connection";
import type { CentrifugeWorkspaceClient } from "#src/connection/centrifuge-workspace-client";
import { DAEMON_SHUTDOWN_NOTICE_TIMEOUT_MS } from "#src/connection/shutdown-notice-timeout";
import { startAgentProxy, type AgentProxy } from "#src/agent-proxy";
import { AgentPreflightError } from "#src/daemon-runtime/agent-preflight-error";
import { AgentSendVerdictError } from "#src/daemon-runtime/agent-send-verdict";
import { AgentTransportError } from "#src/connection/agent-transport-error";
import {
  AGENT_MESSAGE_DRAFT_TTL_MS,
  AgentMessageDraftStore,
} from "#src/persistence/agent-message-draft-store";
import { AgentStateDb } from "#src/persistence/agent-state-db";
import {
  RUNNER_HOLD_REASONS,
  AGENT_SEND_LOCAL_DEADLINE_MS,
  AGENT_SEND_MAX_REQUESTS,
  AGENT_SEND_REQUEST_TIMEOUT_MS,
  AGENT_ACTIVITY_DETAIL_KIND,
  DAEMON_RUNTIME_READY_METHOD,
  type AgentMessageRequest,
  type LocalAgentMessageRequest,
} from "@lrm/coforge-sdk/internal";
import type { LogRecord } from "@logtape/logtape";
import { captureDaemonLogs } from "./log-capture";
import { emptyCodeAgentDiscovery } from "./fixtures/code-agent-discovery";
import { ackGate, createDeliveryGateHarness, deliveryGateSession } from "./fixtures/delivery-gate";
import { createMessageHarness } from "./fixtures/message-harness";
import { messageRecord, readScope } from "./fixtures/message-record";
const tempRoot = realpathSync(tmpdir());
function cliTempStateRoot(
  variable: "COFORGE_CLI_CONSUMED_SEQ_STATE_DIR" | "COFORGE_CLI_DRAFT_STATE_DIR",
) {
  const root = process.env[variable];
  if (!root) throw new Error(`${variable} is unset: run these tests from packages/daemon`);
  return root;
}
const userDirectoryName = encodeURIComponent(
  String(process.geteuid?.() ?? userInfo().username),
).replaceAll(".", "%2E");
const CONSUMED_SEQ_ROOT = join(
  cliTempStateRoot("COFORGE_CLI_CONSUMED_SEQ_STATE_DIR"),
  `coforge-cli-consumed-seq-${userDirectoryName}`,
);
const DRAFT_ROOT = join(
  cliTempStateRoot("COFORGE_CLI_DRAFT_STATE_DIR"),
  `coforge-cli-attested-send-${userDirectoryName}`,
);
const workspaceRoot = join(tempRoot, `coforge-daemon-runtime-${crypto.randomUUID()}`);
const connection: DaemonConfig = {
  computerId: "computer-a",
  workspaceId: "workspace-a",
  workspaceRoot,
};
afterAll(() => rm(workspaceRoot, { recursive: true, force: true }));
const config: AgentRuntimeConfig = {
  provider: "pi",
  model: "default",
  modelProvider: "anthropic",
  reasoning: "balanced",
};
beforeEach(async () => {
  await rm(CONSUMED_SEQ_ROOT, { recursive: true, force: true });
  await rm(DRAFT_ROOT, { recursive: true, force: true });
  await rm(".coforge-daemon-state", { recursive: true, force: true });
});
test("ready and reconnect snapshots report the executable version and observed OS", async () => {
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");
  let snapshot: (() => import("@lrm/coforge-sdk/internal").DaemonRuntimeReadyRequest) | undefined;
  const runtime = new DaemonRuntime(
    connection,
    () => ({ provider: "pi", createAgentSession: async () => sessionSpy() }),
    credentials,
    {
      create: () => ({
        async start() {},
        async stop() {},
        async ready(get) {
          snapshot = get;
        },
      }),
    },
    undefined,
    emptyCodeAgentDiscovery,
    workspaceRoot,
    {},
    "9.8.7",
  );
  try {
    await runtime.start(connection);
    const first = snapshot!();
    expect(first.computerVersion).toBe("9.8.7");
    expect(first.platform).toBe(process.platform);
    expect(first.osVersion).toBeTruthy();
    const reconnect = snapshot!();
    expect(reconnect.computerVersion).toBe("9.8.7");
    expect(reconnect.osVersion).toBe(first.osVersion);
    expect(reconnect.requestId).not.toBe(first.requestId);
  } finally {
    await runtime.stop();
  }
});
test("startup does not wait for optional Code Agent inventory discovery", async () => {
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-inventory-delay");
  let releaseDiscovery!: () => void;
  const discoveryStarted = new Promise<void>((resolve) => {
    releaseDiscovery = resolve;
  });
  const inventoryDiscovery = {
    runtimes: () => discoveryStarted.then(() => []),
    cachedCatalogs: async () => ({ catalogs: [], needsRefresh: false }),
    catalogs: async () => ({ catalogs: [], failures: [] }),
  };
  const runtime = new DaemonRuntime(
    connection,
    () => ({ provider: "pi", createAgentSession: async () => sessionSpy() }),
    credentials,
    {
      create: () => ({
        async start() {},
        async stop() {},
        async ready() {},
      }),
    },
    undefined,
    inventoryDiscovery,
    workspaceRoot,
  );
  const starting = runtime.start(connection);
  const outcome = await Promise.race([
    starting.then(() => "started" as const),
    new Promise<"timed_out">((resolve) => setTimeout(() => resolve("timed_out"), 100)),
  ]);
  releaseDiscovery();
  await starting;
  await runtime.stop();
  expect(outcome).toBe("started");
});
test("a refused Computer upgrade request reports exactly one failed result with its code instead of being swallowed", async () => {
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-upgrade-refused");
  let requestUpgrade: ((requestId: string, expectedVersion?: string) => Promise<void>) | undefined;
  const sentResults: unknown[] = [];
  let acknowledged = 0;
  const runtime = new DaemonRuntime(
    connection,
    () => ({ provider: "pi", createAgentSession: async () => sessionSpy() }),
    credentials,
    {
      create: () => ({
        async start(_token, transportConfig) {
          requestUpgrade = transportConfig.requestUpgrade;
        },
        async stop() {},
        async ready() {},
        async sendUpgradeResult(result: unknown) {
          sentResults.push(result);
          return true;
        },
      }),
    },
    undefined,
    emptyCodeAgentDiscovery,
    workspaceRoot,
    {
      requestUpgrade: async () => {
        const rejection = new Error(
          "Computer upgrade operation prior-request is still pending; wait for it to finish before starting another",
        );
        (
          rejection as Error & {
            code?: string;
          }
        ).code = "UPGRADE_OPERATION_PENDING";
        throw rejection;
      },
      acknowledgeUpgradeResult: async () => {
        acknowledged += 1;
      },
    },
  );
  try {
    await runtime.start(connection);
    await expect(requestUpgrade!("request-refused", "1.2.3")).rejects.toThrow("still pending");
    expect(sentResults).toHaveLength(1);
    expect(sentResults[0]).toMatchObject({
      requestId: "request-refused",
      workspaceId: connection.workspaceId,
      status: "failed",
      errorCode: "UPGRADE_OPERATION_PENDING",
    });
    expect(
      (
        sentResults[0] as {
          error: string;
        }
      ).error,
    ).toContain("still pending");
    expect(acknowledged).toBe(0);
  } finally {
    await runtime.stop();
  }
});
test("first ready reports a terminal upgrade result already present in child config", async () => {
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-upgrade-terminal");
  const events: string[] = [];
  const requestId = "upgrade-terminal";
  const runtime = new DaemonRuntime(
    connection,
    () => ({ provider: "pi", createAgentSession: async () => sessionSpy() }),
    credentials,
    {
      create: () => ({
        async start() {},
        async stop() {},
        async ready() {
          events.push("ready");
        },
        async sendUpgradeResult(result: { requestId: string }) {
          events.push(`result:${result.requestId}`);
          return true;
        },
      }),
    },
    undefined,
    emptyCodeAgentDiscovery,
    workspaceRoot,
    {
      recoveredUpgradeRequestIds: [requestId],
      recoveredUpgradeResults: [
        { requestId, status: "succeeded", version: "2.0.0", completedAtMs: 2000 },
      ],
      acknowledgeUpgradeResult: async (acknowledgedRequestId) => {
        events.push(`ack:${acknowledgedRequestId}`);
      },
    },
    "2.0.0",
  );
  try {
    await runtime.start(connection);
    expect(events).toEqual(["ready", `result:${requestId}`, `ack:${requestId}`]);
  } finally {
    await runtime.stop();
  }
});
test("a duplicate fenced start wakes the managed runtime without replaying recovery context", async () => {
  const stateDirectory = join(tempRoot, `coforge-managed-wake-${crypto.randomUUID()}`);
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");
  const notices: string[] = [];
  let sessions = 0;
  const runtime = new DaemonRuntime(
    connection,
    () => ({
      provider: "pi",
      async createAgentSession() {
        sessions++;
        return {
          ...sessionSpy(),
          notify: async (notice) => {
            notices.push(notice);
          },
          readSessionIdentity: async () => ({ sessionId: "session-a", state: "resumable" }),
        };
      },
    }),
    credentials,
    {
      create: () => ({
        async start() {},
        async ready() {},
        async stop() {},
        async requestAgentLaunchConfig() {
          return agentLaunchConfig(`sk_agent_${"a".repeat(43)}`);
        },
        async revokeAgentApiKey() {},
        async sendAgentControlResult() {},
        async reportAgentSession() {},
      }),
    },
    undefined,
    emptyCodeAgentDiscovery,
    stateDirectory,
  );
  const intent = {
    protocolMajor: 1,
    requestId: "managed-start",
    workspaceId: connection.workspaceId,
    computerId: connection.computerId,
    agentId: "managed-agent",
    ...config,
    controlEpoch: 1,
    launchId: "launch-managed-1",
  };
  try {
    await runtime.start(connection);
    await runtime.handleAgentStart(intent);
    await runtime.handleAgentStart({
      ...intent,
      wakeMessage: {
        messageId: "wake-message",
        deliveryId: "wake-delivery",
        conversationId: "conversation-a",
        sequence: 2,
        target: "@ada",
        latestSenderKind: "human" as const,
        latestSenderHandle: "ada",
        latestSenderDescription: "",
        body: "wake only",
      },
      resumeMessages: [
        {
          messageId: "resume-message",
          deliveryId: "resume-delivery",
          conversationId: "conversation-a",
          sequence: 1,
          target: "@ada",
          latestSenderKind: "human" as const,
          latestSenderHandle: "ada",
          latestSenderDescription: "",
          body: "must be ignored",
        },
      ],
      unreadSummary: { "@grace": 4 },
    });
    expect(sessions).toBe(1);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("[CoForge inbox notice:");
    expect(notices[0]).toContain("@ada 1 new message");
    expect(notices[0]).not.toContain("wake only");
    expect(notices[0]).not.toContain("must be ignored");
    expect(notices[0]).not.toContain("@grace");
  } finally {
    await runtime.stop();
    await rm(stateDirectory, { recursive: true, force: true });
  }
});
test("a Start that meets an already-running process rebinds it: exactly one launch, the next session report/status/activity carry the new scope", async () => {
  const stateDirectory = join(tempRoot, `coforge-rebind-${crypto.randomUUID()}`);
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");
  let sessions = 0;
  const statuses: {
    status: string;
    agentId: string;
  }[] = [];
  const controlResults: {
    phase: string;
    requestId: string;
    launchId?: string;
    epoch: number;
  }[] = [];
  const sessionReports: {
    startRequestId: string;
    controlEpoch?: number;
    launchId: string;
  }[] = [];
  const activities: {
    launchId: string;
    clientSeq: number;
  }[] = [];
  const runtime = new DaemonRuntime(
    connection,
    () => ({
      provider: "pi",
      async createAgentSession() {
        sessions++;
        return {
          ...sessionSpy(),
          readSessionIdentity: async () => ({ sessionId: "session-a", state: "resumable" }),
        };
      },
    }),
    credentials,
    {
      create: () => ({
        async start() {},
        async ready() {},
        async stop() {},
        async requestAgentLaunchConfig() {
          return agentLaunchConfig(`sk_agent_${"a".repeat(43)}`);
        },
        async revokeAgentApiKey() {},
        sendAgentStatus(status) {
          statuses.push({ status: status.status, agentId: status.agentId });
        },
        sendAgentActivity(activity) {
          activities.push({ launchId: activity.launchId, clientSeq: activity.clientSeq });
        },
        async sendAgentControlResult(result) {
          controlResults.push({
            phase: result.phase,
            requestId: result.requestId,
            launchId: result.launchId,
            epoch: result.epoch,
          });
        },
        async reportAgentSession(report) {
          sessionReports.push({
            startRequestId: report.startRequestId,
            controlEpoch: report.controlEpoch,
            launchId: report.launchId,
          });
        },
      }),
    },
    undefined,
    emptyCodeAgentDiscovery,
    stateDirectory,
  );
  const intent = {
    protocolMajor: 1,
    requestId: "rebind-start-1",
    workspaceId: connection.workspaceId,
    computerId: connection.computerId,
    agentId: "rebind-agent",
    ...config,
    controlEpoch: 1,
    launchId: "launch-rebind-1",
  };
  try {
    await runtime.start(connection);
    await runtime.handleAgentStart(intent);
    expect(sessions).toBe(1);
    const startedBeforeRebind = controlResults.filter((r) => r.phase === "started");
    expect(startedBeforeRebind).toHaveLength(1);
    expect(startedBeforeRebind[0]).toMatchObject({ launchId: "launch-rebind-1", epoch: 1 });
    await runtime.handleAgentStart({
      ...intent,
      requestId: "rebind-start-2",
      controlEpoch: 2,
      launchId: "launch-rebind-2",
    });
    expect(sessions).toBe(1);
    const started = controlResults.filter((r) => r.phase === "started");
    expect(started).toHaveLength(2);
    expect(started[1]).toMatchObject({
      requestId: "rebind-start-2",
      epoch: 2,
      launchId: "launch-rebind-2",
    });
    const rebound = sessionReports.at(-1);
    expect(rebound).toMatchObject({
      startRequestId: "rebind-start-2",
      controlEpoch: 2,
      launchId: "launch-rebind-2",
    });
    expect(statuses.filter((s) => s.status === "active").length).toBeGreaterThanOrEqual(2);
    activities.length = 0;
    await runtime.handleAgentActivityProbe({
      protocolMajor: 1,
      requestId: "probe-1",
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      agentId: "rebind-agent",
      probeId: "probe-1",
    });
    for (const activity of activities) expect(activity.launchId).toBe("launch-rebind-2");
  } finally {
    await runtime.stop();
    await rm(stateDirectory, { recursive: true, force: true });
  }
});
test("a recreated daemon waits for cloud start and forwards the cloud-selected session", async () => {
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");
  const sessions: Array<string | undefined> = [];
  const modes: Array<string | undefined> = [];
  const make = () =>
    new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async createAgentSession(options) {
          sessions.push(options.sessionId);
          modes.push(options.sessionMode);
          return sessionSpy();
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async stop() {},
          async requestAgentApiKey() {
            return `sk_agent_${"a".repeat(43)}`;
          },
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
    );
  const original = make();
  await original.start(connection);
  expect(sessions).toEqual([]);
  await original.handleAgentStart({
    protocolMajor: 1,
    requestId: "first",
    workspaceId: connection.workspaceId,
    computerId: connection.computerId,
    agentId: "cloud-agent",
    ...config,
    sessionId: "cloud-first",
    sessionMode: "create",
  });
  await original.stop();
  const recreated = make();
  try {
    await recreated.start(connection);
    expect(sessions).toEqual(["cloud-first"]);
    await recreated.handleAgentStart({
      protocolMajor: 1,
      requestId: "second",
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      agentId: "cloud-agent",
      ...config,
      sessionId: "cloud-selected",
      sessionMode: "resume",
    });
    expect(sessions).toEqual(["cloud-first", "cloud-selected"]);
    expect(modes).toEqual(["create", "resume"]);
  } finally {
    await original.stop();
    await recreated.stop();
  }
});
test("returned identity is acknowledged before Agent readiness and retired callbacks are rejected", async () => {
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");
  const reported = Promise.withResolvers<void>();
  const acknowledged = Promise.withResolvers<void>();
  let callback: ((id: string) => Promise<void>) | undefined;
  const reports: import("@lrm/coforge-sdk/internal").AgentSessionReport[] = [];
  const runtime = new DaemonRuntime(
    connection,
    () => ({
      provider: "pi",
      async createAgentSession(options) {
        callback = options.onSessionId;
        await callback!("returned-session");
        return sessionSpy();
      },
    }),
    credentials,
    {
      create: () => ({
        async start() {},
        async ready() {},
        async stop() {},
        async requestAgentApiKey() {
          return `sk_agent_${"a".repeat(43)}`;
        },
        async reportAgentSession(report) {
          reports.push(report);
          reported.resolve();
          await acknowledged.promise;
        },
      }),
    },
    undefined,
    emptyCodeAgentDiscovery,
  );
  try {
    await runtime.start(connection);
    let ready = false;
    const launch = runtime
      .handleAgentStart({
        protocolMajor: 1,
        requestId: "cloud-start",
        workspaceId: connection.workspaceId,
        computerId: connection.computerId,
        agentId: "reported-agent",
        ...config,
      })
      .then(() => {
        ready = true;
      });
    await reported.promise;
    expect(ready).toBe(false);
    expect(reports[0]).toMatchObject({
      startRequestId: "cloud-start",
      sessionId: "returned-session",
      agentId: "reported-agent",
    });
    acknowledged.resolve();
    await launch;
    await runtime.stop();
    await expect(callback!("late-session")).rejects.toThrow("superseded");
    expect(reports).toHaveLength(1);
  } finally {
    acknowledged.resolve();
    await runtime.stop();
  }
});
function agentLaunchConfig(
  agentApiKey: string,
  providerConfig?: AgentRuntimeConfig["providerConfig"],
) {
  return { agentApiKey, providerConfig };
}
async function queueHarness(
  options: {
    credential?: Promise<string>;
    launch?: () => void | Promise<void>;
    notify?: (notice: string) => void | Promise<void>;
    subscribe?: (listener: (event: AgentRuntimeEvent) => void) => void;
    dispose?: () => void | Promise<void>;
    lifecycle?: (event: string) => void;
    activity?: (activity: import("@lrm/coforge-sdk/internal").AgentActivity) => void;
  } = {},
) {
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");
  const notices: string[] = [];
  const acknowledgements: string[] = [];
  const startupNotices: string[] = [];
  const exitListeners: (() => void)[] = [];
  let sessions = 0;
  let mints = 0;
  let readyFactory:
    | (() => {
        runningAgentIds: string[];
      })
    | undefined;
  const runtime = new DaemonRuntime(
    connection,
    () => ({
      provider: "pi",
      async createAgentSession() {
        await options.launch?.();
        sessions++;
        return {
          ...sessionSpy(),
          async sendMessage(text: string) {
            startupNotices.push(text);
          },
          onExit(listener: () => void) {
            exitListeners.push(listener);
            return () => undefined;
          },
          subscribe(listener: (event: AgentRuntimeEvent) => void) {
            options.subscribe?.(listener);
            return () => undefined;
          },
          async notify(notice: string) {
            if (!notice.includes("That is your MEMORY.md as context, not a request"))
              notices.push(notice);
            await options.notify?.(notice);
          },
          async dispose() {
            await options.dispose?.();
          },
        };
      },
    }),
    credentials,
    {
      create: () => ({
        async start() {},
        async ready(createRequest) {
          readyFactory = createRequest;
        },
        async stop() {},
        async requestAgentLaunchConfig() {
          mints++;
          return agentLaunchConfig(
            options.credential ? await options.credential : `sk_agent_${"a".repeat(43)}`,
          );
        },
        async revokeAgentApiKey() {},
        sendAgentStatus(status) {
          options.lifecycle?.(`status:${status.status}`);
        },
        sendAgentActivity(activity) {
          options.lifecycle?.(`activity:${activity.detailKind}`);
          options.activity?.(activity);
        },
        async sendAgentDeliveryAck(ack) {
          acknowledgements.push(ack.deliveryId);
          options.lifecycle?.(`ack:${ack.deliveryId}`);
        },
      }),
    },
    undefined,
    emptyCodeAgentDiscovery,
  );
  await runtime.start(connection);
  return {
    runtime,
    notices,
    startupNotices,
    acknowledgements,
    sessions: () => sessions,
    mints: () => mints,
    exit: () => {
      for (const listener of exitListeners.splice(0)) listener();
    },
    runningAgentIds: () => readyFactory!().runningAgentIds,
    delivery: (sequence: number) =>
      runtime.handleAgentMessage({
        protocolMajor: 1,
        requestId: `request-${sequence}`,
        messageId: `message-${sequence}`,
        deliveryId: `delivery-${sequence}`,
        sequence,
        workspaceId: connection.workspaceId,
        conversationId: "conversation-a",
        agentId: "agent-a",
        body: "private",
        method: "agent:v1:message:deliver",
        target: "@ada",
      }),
  };
}
const messageHarness = createMessageHarness({ connection, config });
const recovery = {
  resumeMessages: [],
  unreadSummary: { "@ada": 1 },
};
test("channel check and notification settings use the bound Agent without replacing its session", async () => {
  const calls: AgentMessageRequest[] = [];
  const harness = await messageHarness(async (request) => {
    calls.push(request);
    return {
      protocolMajor: 1,
      idempotencyKey: request.idempotencyKey,
      accepted: true,
      attentionCount: 0,
      hasMore: false,
      messages:
        request.operation === "check"
          ? [messageRecord(1, "@alice", "#general"), messageRecord(3, "@bob", "#general")]
          : [],
    };
  });
  try {
    await harness.deliver(1, "#general");
    await harness.deliver(3, "#general");
    const checked = await harness.runtime.agentMessage(
      harness.context,
      { idempotencyKey: "channel-check", context: harness.context, operation: "check" },
      harness.apiKey,
    );
    expect(checked.messages.map((m) => `@${m.senderHandle}`)).toEqual(["@alice", "@bob"]);
    for (const operation of ["mute", "unmute"] as const)
      await harness.runtime.agentMessage(
        harness.context,
        { idempotencyKey: operation, context: harness.context, operation, target: "#general" },
        harness.apiKey,
      );
    await harness.runtime.agentMessage(
      harness.context,
      {
        idempotencyKey: "thread-unfollow",
        context: harness.context,
        operation: "thread-unfollow",
        target: "#general:12345678-0000-4000-8000-000000000001",
      },
      harness.apiKey,
    );
    expect(
      calls.slice(-3).map(({ operation, target, agentId }) => [operation, target, agentId]),
    ).toEqual([
      ["mute", "#general", "agent-a"],
      ["unmute", "#general", "agent-a"],
      ["thread-unfollow", "#general:12345678-0000-4000-8000-000000000001", "agent-a"],
    ]);
  } finally {
    await harness.runtime.stop();
  }
});
test("resolve, react, and unreact reach the transport with messageId, emoji, and the bound Agent", async () => {
  const calls: AgentMessageRequest[] = [];
  const harness = await messageHarness(async (request) => {
    calls.push(request);
    return {
      protocolMajor: 1,
      idempotencyKey: request.idempotencyKey,
      accepted: true,
      attentionCount: 0,
      messages: request.operation === "resolve" ? [messageRecord(1, "@alice", "#general")] : [],
      messageId: request.operation === "react" || request.operation === "unreact" ? "abcd1234" : "",
    };
  });
  try {
    await harness.runtime.agentMessage(
      harness.context,
      {
        idempotencyKey: "resolve-1",
        context: harness.context,
        operation: "resolve",
        messageId: "abcd1234",
      },
      harness.apiKey,
    );
    await harness.runtime.agentMessage(
      harness.context,
      {
        idempotencyKey: "react-1",
        context: harness.context,
        operation: "react",
        messageId: "abcd1234",
        emoji: "👍",
      },
      harness.apiKey,
    );
    await harness.runtime.agentMessage(
      harness.context,
      {
        idempotencyKey: "unreact-1",
        context: harness.context,
        operation: "unreact",
        messageId: "abcd1234",
        emoji: "👍",
      },
      harness.apiKey,
    );
    expect(
      calls.map(({ operation, messageId, emoji, agentId }) => [
        operation,
        messageId,
        emoji,
        agentId,
      ]),
    ).toEqual([
      ["resolve", "abcd1234", undefined, "agent-a"],
      ["react", "abcd1234", "👍", "agent-a"],
      ["unreact", "abcd1234", "👍", "agent-a"],
    ]);
  } finally {
    await harness.runtime.stop();
  }
});
describe("DaemonRuntime", () => {
  test("orders stop completion before replacement start lifecycle", async () => {
    let releaseDispose!: () => void;
    const disposeGate = new Promise<void>((resolve) => (releaseDispose = resolve));
    const lifecycle: string[] = [];
    const harness = await queueHarness({
      dispose: () => disposeGate,
      lifecycle: (event) => lifecycle.push(event),
    });
    const intent = {
      protocolMajor: 1,
      requestId: "start-1",
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      agentId: "agent-a",
      provider: "pi" as const,
      model: "default",
      reasoning: "balanced",
    };
    await harness.runtime.handleAgentStart(intent);
    const stopping = harness.runtime.handleAgentStop({
      protocolMajor: 1,
      requestId: "stop-1",
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      agentId: "agent-a",
    });
    const restarting = harness.runtime.handleAgentStart({ ...intent, requestId: "start-2" });
    await Bun.sleep(0);
    expect(harness.sessions()).toBe(1);
    expect(lifecycle).toEqual(["status:active", "activity:starting"]);
    releaseDispose();
    await Promise.all([stopping, restarting]);
    expect(harness.sessions()).toBe(2);
    expect(lifecycle).toEqual([
      "status:active",
      "activity:starting",
      "status:inactive",
      "activity:stopped",
      "status:active",
      "activity:starting",
    ]);
    await harness.runtime.stop();
  });
  test("control-starts the replacement after a stop whose dispose failed completes", async () => {
    let releaseDispose!: () => void;
    const disposeGate = new Promise<void>((resolve) => (releaseDispose = resolve));
    const harness = await queueHarness({
      async dispose() {
        await disposeGate;
        throw new Error("dispose failed");
      },
    });
    const intent = {
      protocolMajor: 1,
      requestId: "start-1",
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      agentId: "agent-a",
      provider: "pi" as const,
      model: "default",
      reasoning: "balanced",
    };
    await harness.runtime.handleAgentStart(intent);
    const stopping = harness.runtime.handleAgentStop({
      protocolMajor: 1,
      requestId: "stop-1",
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      agentId: "agent-a",
    });
    const restarting = harness.runtime.handleAgentStart({ ...intent, requestId: "start-2" });
    const results = Promise.allSettled([stopping, restarting]);
    releaseDispose();
    expect((await results).map(({ status }) => status)).toEqual(["fulfilled", "fulfilled"]);
    expect(harness.sessions()).toBe(2);
    await harness.runtime.stop();
  });
  test("message check drains the events endpoint in one session, honoring the requested limit", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    let launches = 0;
    const checkRequests: Array<{
      limit?: number;
    }> = [];
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        createAgentSession: async () => {
          launches++;
          return { ...sessionSpy(), async notify() {} };
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async stop() {},
          async requestAgentApiKey() {
            return `sk_agent_${"a".repeat(43)}`;
          },
          async revokeAgentApiKey() {},
          async sendAgentDeliveryAck() {},
          async agentMessage(request) {
            if (request.operation === "check") {
              checkRequests.push(request);
              const round = checkRequests.length;
              return {
                protocolMajor: 1,
                idempotencyKey: request.idempotencyKey,
                accepted: true,
                attentionCount: round === 1 ? 2 : 0,
                hasMore: round === 1,
                messages:
                  round === 1
                    ? [
                        {
                          id: "message-5",
                          sequence: 5,
                          senderKind: "human",
                          senderHandle: "ada",
                          senderDescription: "",
                          target: "@ada",
                          body: "old message",
                          createdAt: "2026-09-03T00:00:00Z",
                          attachments: [],
                        },
                      ]
                    : round === 2
                      ? [
                          {
                            id: "message-7",
                            sequence: 7,
                            senderKind: "human",
                            senderHandle: "ada",
                            senderDescription: "",
                            target: "@ada",
                            body: "new message",
                            createdAt: "2026-09-03T00:01:00Z",
                            attachments: [],
                          },
                        ]
                      : [],
              };
            }
            return {
              protocolMajor: 1,
              idempotencyKey: request.idempotencyKey,
              accepted: true,
              attentionCount: 0,
              messages: [],
            };
          },
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
    );
    await runtime.start(connection);
    await runtime.startAgent("agent-a", config);
    const context = runtime.issueAgentContext("agent-a");
    await runtime.handleAgentMessage({
      protocolMajor: 1,
      requestId: "delivery-request",
      messageId: "message-7",
      deliveryId: "delivery-7",
      sequence: 7,
      workspaceId: connection.workspaceId,
      conversationId: "conversation-a",
      agentId: "agent-a",
      body: "new message",
      method: "agent:v1:message:deliver",
      target: "@ada",
    });
    const first = await runtime.agentMessage(
      context,
      { idempotencyKey: "check-1", context, operation: "check", limit: 1 },
      `sk_agent_${"a".repeat(43)}`,
    );
    const second = await runtime.agentMessage(
      context,
      { idempotencyKey: "check-2", context, operation: "check", limit: 1 },
      `sk_agent_${"a".repeat(43)}`,
    );
    expect(first.messages.map(({ id }) => id)).toEqual(["message-5", "message-7"]);
    expect(first.hasMore).toBe(false);
    expect(second.messages).toEqual([]);
    expect(second.hasMore).toBe(false);
    expect(checkRequests.map((r) => r.limit)).toEqual([1, 1, 1]);
    expect(launches).toBe(1);
    await runtime.stop();
  });
  test.each(["@ada", "@ada:12345678"])(
    "resolves a short thread target for a history read that follows a message check in one session",
    async (target) => {
      const rootId = "12345678-1234-4234-8234-123456789abc";
      const credentials = new InMemoryDaemonCredentialStore();
      await credentials.save(connection.workspaceId, connection.computerId, "token-a");
      let launches = 0;
      const requests: Array<{
        before?: string;
        around?: string;
        limit?: number;
      }> = [];
      const runtime = new DaemonRuntime(
        connection,
        () => ({
          provider: "pi",
          createAgentSession: async () => {
            launches++;
            return { ...sessionSpy(), async notify() {} };
          },
        }),
        credentials,
        {
          create: () => ({
            async start() {},
            async ready() {},
            async stop() {},
            async requestAgentApiKey() {
              return `sk_agent_${"a".repeat(43)}`;
            },
            async revokeAgentApiKey() {},
            async sendAgentDeliveryAck() {},
            async agentMessage(request) {
              if (request.operation === "check")
                return {
                  protocolMajor: 1,
                  idempotencyKey: request.idempotencyKey,
                  accepted: true,
                  attentionCount: 0,
                  hasMore: false,
                  messages: [],
                };
              if (
                target.includes(":") &&
                request.target === "@ada" &&
                request.around === "12345678"
              )
                return {
                  protocolMajor: 1,
                  idempotencyKey: request.idempotencyKey,
                  accepted: true,
                  attentionCount: 0,
                  messages: [
                    {
                      id: rootId,
                      sequence: 1,
                      senderKind: "human",
                      senderHandle: "ada",
                      senderDescription: "",
                      target: "@ada",
                      body: "root",
                      createdAt: "2026-09-03T00:00:00Z",
                      attachments: [],
                    },
                  ],
                };
              requests.push(request);
              return {
                protocolMajor: 1,
                idempotencyKey: request.idempotencyKey,
                accepted: true,
                attentionCount: 0,
                messages: [],
              };
            },
          }),
        },
        undefined,
        emptyCodeAgentDiscovery,
      );
      await runtime.start(connection);
      await runtime.startAgent("agent-a", config);
      const context = runtime.issueAgentContext("agent-a");
      await runtime.agentMessage(
        context,
        { idempotencyKey: "check-1", context, operation: "check" },
        `sk_agent_${"a".repeat(43)}`,
      );
      await runtime.agentMessage(
        context,
        {
          idempotencyKey: "history",
          context,
          operation: "read",
          target,
          around: "12345678",
          limit: 1,
        },
        `sk_agent_${"a".repeat(43)}`,
      );
      expect(requests.at(-1)).toMatchObject({ around: "12345678", limit: 1 });
      expect(launches).toBe(1);
      await runtime.stop();
    },
  );
  test.each(["read", "search"] as const)(
    "a message shown by `message %s` beyond the frontier is announced again only if the Agent did not read it",
    async (operation) => {
      const credentials = new InMemoryDaemonCredentialStore();
      await credentials.save(connection.workspaceId, connection.computerId, "token-a");
      const notices: string[] = [];
      const acknowledgements: string[] = [];
      const runtime = new DaemonRuntime(
        connection,
        () => ({
          provider: "pi",
          createAgentSession: async () => ({
            ...sessionSpy(),
            notify: async (notice) => {
              notices.push(notice);
            },
          }),
        }),
        credentials,
        {
          create: () => ({
            async start() {},
            async ready() {},
            async stop() {},
            async requestAgentApiKey() {
              return `sk_agent_${"a".repeat(43)}`;
            },
            async revokeAgentApiKey() {},
            async sendAgentDeliveryAck(ack) {
              acknowledgements.push(ack.deliveryId);
            },
            agentMessage: async (request) => ({
              protocolMajor: 1,
              idempotencyKey: request.idempotencyKey,
              accepted: true,
              attentionCount: 0,
              messages: [messageRecord(7, "@ada", "@ada")],
              consumptionScope: readScope(request.agentId, "@ada"),
            }),
          }),
        },
        undefined,
        emptyCodeAgentDiscovery,
      );
      try {
        await runtime.start(connection);
        await runtime.startAgent("agent-a", config);
        const context = runtime.issueAgentContext("agent-a");
        await runtime.agentMessage(
          context,
          operation === "read"
            ? { idempotencyKey: "anchored", context, operation, target: "@ada", around: "12345678" }
            : { idempotencyKey: "search", context, operation, query: "body" },
          `sk_agent_${"a".repeat(43)}`,
        );
        await runtime.handleAgentMessage({
          protocolMajor: 1,
          requestId: "delivery-7",
          messageId: "message-7",
          deliveryId: "delivery-7",
          sequence: 7,
          workspaceId: connection.workspaceId,
          conversationId: "conversation-a",
          agentId: "agent-a",
          body: "body-7",
          method: "agent:v1:message:deliver",
          target: "@ada",
        });
        expect(notices).toHaveLength(operation === "read" ? 0 : 1);
        expect(acknowledgements).toEqual(["delivery-7"]);
      } finally {
        await runtime.stop();
      }
    },
  );
  test("resolves a short channel thread target through its parent channel", async () => {
    const rootId = "abcdef12-1234-4234-8234-123456789abc";
    const fullTarget = `#general:${rootId}`;
    const requests: AgentMessageRequest[] = [];
    const harness = await messageHarness(async (request) => {
      requests.push(request);
      if (request.target === "#general")
        return {
          protocolMajor: 1,
          idempotencyKey: request.idempotencyKey,
          accepted: true,
          attentionCount: 0,
          messages: [messageRecord(1, "@ada", "#general", rootId)],
        };
      return {
        protocolMajor: 1,
        idempotencyKey: request.idempotencyKey,
        accepted: true,
        attentionCount: 0,
        messageId: request.operation === "send" ? "sent" : undefined,
        messages: [],
      };
    });
    try {
      await harness.runtime.agentMessage(
        harness.context,
        {
          idempotencyKey: "send-channel-thread",
          context: harness.context,
          operation: "send",
          target: "#general:abcdef12",
          content: "thread reply",
        },
        harness.apiKey,
      );
      expect(requests.at(-1)).toMatchObject({
        operation: "send",
        target: fullTarget,
      });
    } finally {
      await harness.runtime.stop();
    }
  });
  test("reuses a short-target held draft's content when sent with the full target", async () => {
    const rootId = "12345678-1234-4234-8234-123456789abc";
    const fullTarget = `@ada:${rootId}`;
    const sends: AgentMessageRequest[] = [];
    const harness = await messageHarness(async (request) => {
      if (request.target === "@ada")
        return {
          protocolMajor: 1,
          idempotencyKey: request.idempotencyKey,
          accepted: true,
          attentionCount: 0,
          messages: [messageRecord(1, "@ada", "@ada", rootId)],
        };
      sends.push(request);
      return sends.length === 1
        ? {
            protocolMajor: 1,
            idempotencyKey: request.idempotencyKey,
            accepted: false,
            attentionCount: 1,
            messages: [],
            state: "held",
            decision: "local_hold",
          }
        : {
            protocolMajor: 1,
            idempotencyKey: request.idempotencyKey,
            accepted: true,
            attentionCount: 0,
            messageId: "sent",
            messages: [],
            state: "sent",
            decision: "forward",
          };
    });
    try {
      await harness.runtime.agentMessage(
        harness.context,
        {
          idempotencyKey: "hold-short",
          context: harness.context,
          operation: "send",
          target: "@ada:12345678",
          content: "original body",
        },
        harness.apiKey,
      );
      await harness.runtime.agentMessage(
        harness.context,
        {
          idempotencyKey: "send-full-draft",
          context: harness.context,
          operation: "send",
          target: fullTarget,
          sendDraft: true,
        },
        harness.apiKey,
      );
      expect(sends[1]).toMatchObject({
        target: fullTarget,
        content: "original body",
        draftReholdCount: 1,
      });
    } finally {
      await harness.runtime.stop();
    }
  });
  test("blocks a top-level send after a more recently read thread, saves the draft, and --send-draft resends it unchanged", async () => {
    const rootId = "12345678-1234-4234-8234-123456789abc";
    const sends: AgentMessageRequest[] = [];
    const harness = await messageHarness(async (request) => {
      if (request.operation === "read")
        return {
          protocolMajor: 1,
          idempotencyKey: request.idempotencyKey,
          accepted: true,
          attentionCount: 0,
          messages: [messageRecord(1, "@ada", request.target)],
          modelSeenUpToSeq: 1,
        };
      sends.push(request);
      return {
        protocolMajor: 1,
        idempotencyKey: request.idempotencyKey,
        accepted: true,
        attentionCount: 0,
        messageId: "sent",
        messages: [],
        state: "sent",
        decision: "forward",
      };
    });
    try {
      await harness.runtime.agentMessage(
        harness.context,
        {
          idempotencyKey: "read-thread",
          context: harness.context,
          operation: "read",
          target: `@ada:${rootId}`,
        },
        harness.apiKey,
      );
      const blocked = await harness.runtime
        .agentMessage(
          harness.context,
          {
            idempotencyKey: "blocked-send",
            context: harness.context,
            operation: "send",
            target: "@ada",
            content: "top-level reply",
          },
          harness.apiKey,
        )
        .catch((error: unknown) => error);
      expect(blocked).toBeInstanceOf(AgentPreflightError);
      const preflight = blocked as AgentPreflightError;
      expect(preflight.code).toBe("THREAD_CONTEXT_TARGET_CONFIRMATION_REQUIRED");
      expect(preflight.message).toContain("Possible thread target mismatch");
      expect(preflight.message).toContain('coforge message send --send-draft --target "@ada"');
      expect(preflight.verdict.draftSaved).toBe(true);
      expect(sends).toEqual([]);
      await harness.runtime.agentMessage(
        harness.context,
        {
          idempotencyKey: "resend-saved-draft",
          context: harness.context,
          operation: "send",
          target: "@ada",
          sendDraft: true,
        },
        harness.apiKey,
      );
      expect(sends).toHaveLength(1);
      expect(sends[0]).toMatchObject({
        target: "@ada",
        content: "top-level reply",
        idempotencyKey: "blocked-send",
      });
      await harness.runtime.agentMessage(
        harness.context,
        {
          idempotencyKey: "confirmed-send",
          context: harness.context,
          operation: "send",
          target: "@ada",
          content: "top-level reply",
          targetConfirmed: true,
        },
        harness.apiKey,
      );
      expect(sends).toHaveLength(2);
      expect(sends[1]).toMatchObject({ target: "@ada" });
    } finally {
      await harness.runtime.stop();
    }
  });
  describe("which thread read makes a top-level send ask for confirmation", () => {
    const rootId = "12345678-1234-4234-8234-123456789abc";
    const threadTarget = `@ada:${rootId}`;
    async function guardHarness(
      rowsFor: (request: AgentMessageRequest) => number[],
      contiguous: (request: AgentMessageRequest) => boolean = () => true,
    ) {
      const sends: AgentMessageRequest[] = [];
      const harness = await messageHarness(async (request) => {
        if (request.operation === "read" || request.operation === "check") {
          const rows = rowsFor(request);
          return {
            protocolMajor: 1,
            idempotencyKey: request.idempotencyKey,
            accepted: true,
            attentionCount: 0,
            messages: rows.map((sequence) =>
              messageRecord(sequence, "@ada", request.target || "@ada"),
            ),
            ...(request.operation === "read"
              ? {
                  consumptionScope: readScope(request.agentId, request.target),
                  modelSeenUpToSeq: rows.length && contiguous(request) ? Math.max(...rows) : null,
                }
              : {}),
          };
        }
        sends.push(request);
        return {
          protocolMajor: 1,
          idempotencyKey: request.idempotencyKey,
          accepted: true,
          attentionCount: 0,
          messageId: "sent",
          messages: [],
          state: "sent",
          decision: "forward",
        };
      });
      const run = (request: Omit<LocalAgentMessageRequest, "context">) =>
        harness.runtime.agentMessage(
          harness.context,
          { ...request, context: harness.context },
          harness.apiKey,
        );
      const sendTopLevel = () =>
        run({
          idempotencyKey: "top-level-send",
          operation: "send",
          target: "@ada",
          content: "top-level reply",
        }).catch((error: unknown) => error);
      return { harness, sends, run, sendTopLevel };
    }
    test("a thread read that returned no messages does not count", async () => {
      const { harness, sends, run, sendTopLevel } = await guardHarness((request) =>
        request.target === "@ada" ? [7] : [],
      );
      try {
        await run({ idempotencyKey: "check-parent", operation: "check", target: "@ada" });
        await run({ idempotencyKey: "read-empty-thread", operation: "read", target: threadTarget });
        const result = await sendTopLevel();
        expect(result).not.toBeInstanceOf(AgentPreflightError);
        expect(sends).toHaveLength(1);
        expect(sends[0]).toMatchObject({ target: "@ada", content: "top-level reply" });
      } finally {
        await harness.runtime.stop();
      }
    });
    test("a thread read with --around does not count", async () => {
      const { harness, sends, run, sendTopLevel } = await guardHarness(() => [3]);
      try {
        await run({
          idempotencyKey: "read-thread-around",
          operation: "read",
          target: threadTarget,
          around: "message-3",
        });
        const result = await sendTopLevel();
        expect(result).not.toBeInstanceOf(AgentPreflightError);
        expect(sends).toHaveLength(1);
      } finally {
        await harness.runtime.stop();
      }
    });
    test("a paged thread read that returned messages counts", async () => {
      const { harness, sends, run, sendTopLevel } = await guardHarness(() => [3]);
      try {
        await run({
          idempotencyKey: "read-thread-after",
          operation: "read",
          target: threadTarget,
          after: "message-1",
        });
        const asked = await sendTopLevel();
        expect(asked).toBeInstanceOf(AgentPreflightError);
        expect((asked as AgentPreflightError).code).toBe(
          "THREAD_CONTEXT_TARGET_CONFIRMATION_REQUIRED",
        );
        expect(sends).toEqual([]);
      } finally {
        await harness.runtime.stop();
      }
    });
    test("a paged thread read the server does not call contiguous does not count", async () => {
      const { harness, sends, run, sendTopLevel } = await guardHarness(
        () => [3],
        () => false,
      );
      try {
        await run({
          idempotencyKey: "read-thread-before",
          operation: "read",
          target: threadTarget,
          before: "message-9",
        });
        const result = await sendTopLevel();
        expect(result).not.toBeInstanceOf(AgentPreflightError);
        expect(sends).toHaveLength(1);
      } finally {
        await harness.runtime.stop();
      }
    });
    test("thread messages a check drained do not make a later empty thread read count", async () => {
      const { harness, sends, run, sendTopLevel } = await guardHarness((request) =>
        request.operation === "check" ? [5] : [],
      );
      try {
        await run({ idempotencyKey: "check-thread", operation: "check", target: threadTarget });
        await run({ idempotencyKey: "read-empty-thread", operation: "read", target: threadTarget });
        const result = await sendTopLevel();
        expect(result).not.toBeInstanceOf(AgentPreflightError);
        expect(sends).toHaveLength(1);
      } finally {
        await harness.runtime.stop();
      }
    });
    test("a held send whose context was withheld does not count", async () => {
      const sends: AgentMessageRequest[] = [];
      const harness = await messageHarness(async (request) => {
        sends.push(request);
        return request.target === threadTarget
          ? {
              protocolMajor: 1,
              idempotencyKey: request.idempotencyKey,
              accepted: false,
              attentionCount: 1,
              messages: [messageRecord(9, "@ada", threadTarget)],
              state: "held",
              decision: "local_hold" as const,
              freshnessContextMode: "withheld" as const,
            }
          : {
              protocolMajor: 1,
              idempotencyKey: request.idempotencyKey,
              accepted: true,
              attentionCount: 0,
              messageId: "sent",
              messages: [],
              state: "sent",
              decision: "forward",
            };
      });
      try {
        await harness.runtime.agentMessage(
          harness.context,
          {
            idempotencyKey: "withheld-thread-send",
            context: harness.context,
            operation: "send",
            target: threadTarget,
            content: "thread reply",
            freshnessContextMode: "withheld",
          },
          harness.apiKey,
        );
        const result = await harness.runtime
          .agentMessage(
            harness.context,
            {
              idempotencyKey: "top-level-send",
              context: harness.context,
              operation: "send",
              target: "@ada",
              content: "top-level reply",
            },
            harness.apiKey,
          )
          .catch((error: unknown) => error);
        expect(result).not.toBeInstanceOf(AgentPreflightError);
        expect(sends.map(({ target }) => target)).toEqual([threadTarget, "@ada"]);
      } finally {
        await harness.runtime.stop();
      }
    });
    test("checking the parent after reading a thread still asks, until the parent is read", async () => {
      const { harness, sends, run, sendTopLevel } = await guardHarness((request) =>
        request.target === threadTarget ? [3] : [9],
      );
      try {
        await run({ idempotencyKey: "read-thread", operation: "read", target: threadTarget });
        await run({ idempotencyKey: "check-parent", operation: "check", target: "@ada" });
        const asked = await sendTopLevel();
        expect(asked).toBeInstanceOf(AgentPreflightError);
        expect((asked as AgentPreflightError).code).toBe(
          "THREAD_CONTEXT_TARGET_CONFIRMATION_REQUIRED",
        );
        expect(sends).toEqual([]);
        await run({ idempotencyKey: "read-parent", operation: "read", target: "@ada" });
        const result = await run({
          idempotencyKey: "top-level-after-parent-read",
          operation: "send",
          target: "@ada",
          content: "top-level reply",
        });
        expect(result.accepted).toBe(true);
        expect(sends).toHaveLength(1);
      } finally {
        await harness.runtime.stop();
      }
    });
  });
  test("a --send-draft resend forwards --anyway instead of refusing it", async () => {
    const rootId = "12345678-1234-4234-8234-123456789abc";
    const sends: AgentMessageRequest[] = [];
    const harness = await messageHarness(async (request) => {
      if (request.operation === "read")
        return {
          protocolMajor: 1,
          idempotencyKey: request.idempotencyKey,
          accepted: true,
          attentionCount: 0,
          messages: [messageRecord(1, "@ada", request.target)],
          modelSeenUpToSeq: 1,
        };
      sends.push(request);
      return {
        protocolMajor: 1,
        idempotencyKey: request.idempotencyKey,
        accepted: true,
        attentionCount: 0,
        messageId: "sent",
        messages: [],
        state: "sent",
        decision: "forward",
      };
    });
    try {
      await harness.runtime.agentMessage(
        harness.context,
        {
          idempotencyKey: "read-thread",
          context: harness.context,
          operation: "read",
          target: `@ada:${rootId}`,
        },
        harness.apiKey,
      );
      await harness.runtime
        .agentMessage(
          harness.context,
          {
            idempotencyKey: "blocked-send",
            context: harness.context,
            operation: "send",
            target: "@ada",
            content: "top-level reply",
          },
          harness.apiKey,
        )
        .catch(() => undefined);
      await harness.runtime.agentMessage(
        harness.context,
        {
          idempotencyKey: "resend-anyway",
          context: harness.context,
          operation: "send",
          target: "@ada",
          sendDraft: true,
          continueAnyway: true,
        },
        harness.apiKey,
      );
      expect(sends).toHaveLength(1);
      expect(sends[0]).toMatchObject({ continueAnyway: true, draftReholdCount: 0 });
    } finally {
      await harness.runtime.stop();
    }
  });
  test("the mention-in-content check runs on a --send-draft resend against the effective mentions", async () => {
    const sends: AgentMessageRequest[] = [];
    const harness = await messageHarness(async (request) => {
      sends.push(request);
      return {
        protocolMajor: 1,
        idempotencyKey: request.idempotencyKey,
        accepted: false,
        attentionCount: 1,
        messages: [],
        state: "held",
        decision: "local_hold",
      };
    });
    try {
      await harness.runtime.agentMessage(
        harness.context,
        {
          idempotencyKey: "held-send",
          context: harness.context,
          operation: "send",
          target: "@ada",
          content: "hi @ada",
          mentions: [{ type: "user", id: "actor-1", name: "ada" }],
        },
        harness.apiKey,
      );
      expect(sends).toHaveLength(1);
      const rejected = await harness.runtime
        .agentMessage(
          harness.context,
          {
            idempotencyKey: "resend-with-bad-override",
            context: harness.context,
            operation: "send",
            target: "@ada",
            sendDraft: true,
            mentions: [{ type: "user", id: "actor-2", name: "ghost" }],
          },
          harness.apiKey,
        )
        .catch((error: unknown) => error);
      expect(rejected).toBeInstanceOf(AgentPreflightError);
      expect((rejected as AgentPreflightError).code).toBe("MENTION_NOT_IN_CONTENT");
      expect((rejected as Error).message).toBe(
        "Structured mention @ghost is not present in the message body.",
      );
      expect(sends).toHaveLength(1);
    } finally {
      await harness.runtime.stop();
    }
  });
  test("does not block a top-level send when the parent itself was read more recently than any thread", async () => {
    const rootId = "12345678-1234-4234-8234-123456789abc";
    const sends: AgentMessageRequest[] = [];
    const harness = await messageHarness(async (request) => {
      if (request.operation === "read")
        return {
          protocolMajor: 1,
          idempotencyKey: request.idempotencyKey,
          accepted: true,
          attentionCount: 0,
          messages: [messageRecord(1, "@ada", request.target)],
          modelSeenUpToSeq: 1,
        };
      sends.push(request);
      return {
        protocolMajor: 1,
        idempotencyKey: request.idempotencyKey,
        accepted: true,
        attentionCount: 0,
        messageId: "sent",
        messages: [],
        state: "sent",
        decision: "forward",
      };
    });
    try {
      await harness.runtime.agentMessage(
        harness.context,
        {
          idempotencyKey: "read-thread",
          context: harness.context,
          operation: "read",
          target: `@ada:${rootId}`,
        },
        harness.apiKey,
      );
      await harness.runtime.agentMessage(
        harness.context,
        {
          idempotencyKey: "read-parent",
          context: harness.context,
          operation: "read",
          target: "@ada",
        },
        harness.apiKey,
      );
      await harness.runtime.agentMessage(
        harness.context,
        {
          idempotencyKey: "unconfirmed-send",
          context: harness.context,
          operation: "send",
          target: "@ada",
          content: "top-level reply",
        },
        harness.apiKey,
      );
      expect(sends).toHaveLength(1);
    } finally {
      await harness.runtime.stop();
    }
  });
  test("forwards attachmentIds and mentions on send; --send-draft resend reuses them unless overridden", async () => {
    const sends: AgentMessageRequest[] = [];
    const mentions = [{ type: "user" as const, id: "actor-1", name: "ada" }];
    const harness = await messageHarness(async (request) => {
      sends.push(request);
      if (sends.length === 1)
        return {
          protocolMajor: 1,
          idempotencyKey: request.idempotencyKey,
          accepted: false,
          attentionCount: 1,
          messages: [],
          state: "held",
          decision: "local_hold",
        };
      return {
        protocolMajor: 1,
        idempotencyKey: request.idempotencyKey,
        accepted: true,
        attentionCount: 0,
        messageId: "sent",
        messages: [],
        state: "sent",
        decision: "forward",
      };
    });
    try {
      await harness.runtime.agentMessage(
        harness.context,
        {
          idempotencyKey: "held-send",
          context: harness.context,
          operation: "send",
          target: "@ada",
          content: "first body @ada",
          attachmentIds: ["attachment-1", "attachment-2"],
          mentions,
        },
        harness.apiKey,
      );
      expect(sends[0]).toMatchObject({
        attachmentIds: ["attachment-1", "attachment-2"],
        mentions,
      });
      await harness.runtime.agentMessage(
        harness.context,
        {
          idempotencyKey: "resend-draft",
          context: harness.context,
          operation: "send",
          target: "@ada",
          sendDraft: true,
        },
        harness.apiKey,
      );
      expect(sends[1]).toMatchObject({
        attachmentIds: ["attachment-1", "attachment-2"],
        mentions,
      });
    } finally {
      await harness.runtime.stop();
    }
  });
  test("an explicit --mention on --send-draft replaces the draft's saved mentions", async () => {
    const sends: AgentMessageRequest[] = [];
    const overrideMentions = [{ type: "agent" as const, id: "actor-2", name: "helper" }];
    const harness = await messageHarness(async (request) => {
      sends.push(request);
      if (sends.length === 1)
        return {
          protocolMajor: 1,
          idempotencyKey: request.idempotencyKey,
          accepted: false,
          attentionCount: 1,
          messages: [],
          state: "held",
          decision: "local_hold",
        };
      return {
        protocolMajor: 1,
        idempotencyKey: request.idempotencyKey,
        accepted: true,
        attentionCount: 0,
        messageId: "sent",
        messages: [],
        state: "sent",
        decision: "forward",
      };
    });
    try {
      await harness.runtime.agentMessage(
        harness.context,
        {
          idempotencyKey: "held-send",
          context: harness.context,
          operation: "send",
          target: "@ada",
          content: "first body @ada @helper",
          mentions: [{ type: "user", id: "actor-1", name: "ada" }],
        },
        harness.apiKey,
      );
      await harness.runtime.agentMessage(
        harness.context,
        {
          idempotencyKey: "resend-draft-with-override",
          context: harness.context,
          operation: "send",
          target: "@ada",
          sendDraft: true,
          mentions: overrideMentions,
        },
        harness.apiKey,
      );
      expect(sends[1]).toMatchObject({ mentions: overrideMentions });
    } finally {
      await harness.runtime.stop();
    }
  });
  test("a sent message's undelivered mentions are returned to the Agent unchanged", async () => {
    const pendingMentionActions = [
      {
        resolutionId: "22222222-2222-4222-8222-222222222222",
        messageId: "sent-1",
        targetType: "user" as const,
        targetHandle: "bob",
        targetAvatarUrl: null,
        reason: "not_member" as const,
        availableActions: [],
        expiresAt: "2026-10-01T00:00:00.000Z",
      },
    ];
    const harness = await messageHarness(async (request) => ({
      protocolMajor: 1,
      idempotencyKey: request.idempotencyKey,
      accepted: true,
      attentionCount: 0,
      messageId: "sent-1",
      messages: [],
      state: "sent",
      decision: "forward",
      pendingMentionActions,
      unresolvedMentionHandles: ["ghost"],
    }));
    try {
      const result = await harness.runtime.agentMessage(
        harness.context,
        {
          idempotencyKey: "mention-send",
          context: harness.context,
          operation: "send",
          target: "#triage",
          content: "@bob @ghost look",
        },
        harness.apiKey,
      );
      expect(result.pendingMentionActions).toEqual(pendingMentionActions);
      expect(result.unresolvedMentionHandles).toEqual(["ghost"]);
    } finally {
      await harness.runtime.stop();
    }
  });
  test("an empty read clears only attention that existed when the read started", async () => {
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => (releaseRead = resolve));
    let markReadEntered!: () => void;
    const readEntered = new Promise<void>((resolve) => (markReadEntered = resolve));
    const harness = await messageHarness(async (request) => {
      if (request.operation === "read" && request.idempotencyKey === "held-read") {
        markReadEntered();
        await readGate;
      }
      return {
        protocolMajor: 1,
        idempotencyKey: request.idempotencyKey,
        accepted: true,
        attentionCount: 0,
        messages:
          request.idempotencyKey === "check-after-race" ? [messageRecord(9, "@ada", "@ada")] : [],
      };
    });
    try {
      await harness.deliver(7, "@ada");
      const reading = harness.runtime.agentMessage(
        harness.context,
        {
          idempotencyKey: "held-read",
          context: harness.context,
          operation: "read",
          target: "@ada",
        },
        harness.apiKey,
      );
      await readEntered;
      await harness.deliver(9, "@ada");
      releaseRead();
      await reading;
      const pending = await harness.runtime.agentMessage(
        harness.context,
        { idempotencyKey: "check-after-race", context: harness.context, operation: "check" },
        harness.apiKey,
      );
      expect(pending.summaries).toEqual([
        expect.objectContaining({ target: "@ada", latestSequence: 9 }),
      ]);
    } finally {
      releaseRead();
      await harness.runtime.stop();
    }
  });
  test.each([
    ["rejected", false, []],
    ["wrong-target", true, [messageRecord(7, "@bea", "@bea")]],
  ])("a %s read result does not clear target attention", async (_case, accepted, messages) => {
    const harness = await messageHarness(async (request) => ({
      protocolMajor: 1,
      idempotencyKey: request.idempotencyKey,
      accepted,
      attentionCount: 1,
      messages:
        request.idempotencyKey === "check-preserved"
          ? [messageRecord(7, "@ada", "@ada")]
          : messages,
    }));
    try {
      await harness.deliver(7, "@ada");
      await harness.runtime.agentMessage(
        harness.context,
        {
          idempotencyKey: "read-result",
          context: harness.context,
          operation: "read",
          target: "@ada",
        },
        harness.apiKey,
      );
      const pending = await harness.runtime.agentMessage(
        harness.context,
        { idempotencyKey: "check-preserved", context: harness.context, operation: "check" },
        harness.apiKey,
      );
      expect(pending.summaries).toEqual([expect.objectContaining({ target: "@ada" })]);
    } finally {
      await harness.runtime.stop();
    }
  });
  test("workspace info without a valid Agent API key is the AGENT_API_KEY_MISSING precondition", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    let forwarded = 0;
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        createAgentSession: async () => ({ ...sessionSpy(), async notify() {} }),
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async stop() {},
          requestAgentApiKey: async () => `sk_agent_${"a".repeat(43)}`,
          async workspaceInfo() {
            forwarded += 1;
            return {} as never;
          },
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
    );
    await runtime.start(connection);
    await runtime.startAgent("agent-a", config);
    const context = runtime.issueAgentContext("agent-a");
    const rejected = await runtime.agentRequests
      .workspaceInfo(context, { idempotencyKey: "r" }, "not-an-agent-key")
      .catch((error: unknown) => error);
    expect(rejected).toBeInstanceOf(AgentPreflightError);
    expect((rejected as AgentPreflightError).code).toBe("AGENT_API_KEY_MISSING");
    expect(forwarded).toBe(0);
    await runtime.stop();
  });
  test("every forwarded Agent request refuses a local precondition as that precondition, forwarding nothing", async () => {
    const forwardedRequests = [
      "workspaceInfo",
      "githubCredential",
      "githubCommitTrailers",
      "manualGet",
      "manualSearch",
      "userInfo",
      "profileShow",
      "profileUpdate",
      "appConfigGet",
      "appConfigUpdate",
      "mentionPending",
      "mentionExecute",
      "mentionDelivery",
      "agentChannel",
      "agentActionPrepare",
      "agentWeeklyReport",
      "agentWeeklyReportCollect",
      "agentWeeklyReportKeyPoints",
      "agentWeeklyReportMemory",
      "agentAttachment",
      "agentAttachmentUpload",
      "agentAttachmentUploadSessionCreate",
      "agentAttachmentUploadSessionComplete",
      "agentAttachmentUploadSessionCancel",
      "agentAttachmentUploadSessionGet",
    ] as const;
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const forwarded: string[] = [];
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        createAgentSession: async () => ({ ...sessionSpy(), async notify() {} }),
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async stop() {},
          requestAgentApiKey: async () => `sk_agent_${"a".repeat(43)}`,
          ...Object.fromEntries(
            forwardedRequests.map((name) => [
              name,
              async () => {
                forwarded.push(name);
                return {};
              },
            ]),
          ),
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
    );
    await runtime.start(connection);
    await runtime.startAgent("agent-a", config);
    const context = runtime.issueAgentContext("agent-a");
    const agentApiKey = `sk_agent_${"a".repeat(43)}`;
    const refusal = async (name: (typeof forwardedRequests)[number], ...input: unknown[]) => {
      const request = runtime.agentRequests[name] as (...input: unknown[]) => Promise<unknown>;
      const error = await request.call(runtime.agentRequests, ...input).catch((error) => error);
      return error instanceof AgentPreflightError ? error.code : String(error);
    };
    for (const name of forwardedRequests) {
      expect([name, await refusal(name, context, {}, "not-an-agent-key")]).toEqual([
        name,
        "AGENT_API_KEY_MISSING",
      ]);
      expect([name, await refusal(name, "forged-context", {}, agentApiKey)]).toEqual([
        name,
        "AGENT_CONTEXT_INVALID",
      ]);
    }
    await runtime.stop();
    for (const name of forwardedRequests)
      expect([name, await refusal(name, context, {}, agentApiKey)]).toEqual([
        name,
        "DAEMON_NOT_RUNNING",
      ]);
    expect(forwarded).toEqual([]);
  });
  test("version answers coforge version's local-only query from the already-running process, without a transport call", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-version");
    const runtime = new DaemonRuntime(
      connection,
      () => ({ provider: "pi", createAgentSession: async () => sessionSpy() }),
      credentials,
      { create: () => ({ async start() {}, async ready() {}, async stop() {} }) },
      undefined,
      emptyCodeAgentDiscovery,
      workspaceRoot,
      {},
      "9.8.7",
    );
    try {
      await runtime.start(connection);
      const context = runtime.issueAgentContext("agent-a");
      const response = await runtime.version(context, {}, `sk_agent_${"a".repeat(43)}`);
      expect(response.ok).toBe(true);
      expect(response.daemonVersion).toBeTruthy();
      expect(response.computerVersion).toBe("9.8.7");
      expect(response.daemonPid).toBe(process.pid);
      expect(typeof response.startedAt).toBe("number");
    } finally {
      await runtime.stop();
    }
  });
  test("version without a valid Agent API key is the AGENT_API_KEY_MISSING precondition", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-version-invalid");
    const runtime = new DaemonRuntime(
      connection,
      () => ({ provider: "pi", createAgentSession: async () => sessionSpy() }),
      credentials,
      { create: () => ({ async start() {}, async ready() {}, async stop() {} }) },
      undefined,
      emptyCodeAgentDiscovery,
      workspaceRoot,
      {},
      "9.8.7",
    );
    try {
      await runtime.start(connection);
      const context = runtime.issueAgentContext("agent-a");
      const rejected = await runtime
        .version(context, {}, "not-an-agent-key")
        .catch((error: unknown) => error);
      expect(rejected).toBeInstanceOf(AgentPreflightError);
      expect((rejected as AgentPreflightError).code).toBe("AGENT_API_KEY_MISSING");
    } finally {
      await runtime.stop();
    }
  });
  test("message check drains multiple event pages and preserves attention without scoped evidence", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const limits: Array<number | undefined> = [];
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        createAgentSession: async () => ({ ...sessionSpy(), async notify() {} }),
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async stop() {},
          async requestAgentLaunchConfig() {
            return agentLaunchConfig(`sk_agent_${"a".repeat(43)}`);
          },
          async revokeAgentApiKey() {},
          async sendAgentDeliveryAck() {},
          async agentMessage(request) {
            limits.push(request.limit);
            const round = limits.length;
            if (round === 1)
              return {
                protocolMajor: 1,
                idempotencyKey: request.idempotencyKey,
                accepted: true,
                attentionCount: 2,
                hasMore: true,
                messages: [messageRecord(1, "@ada", "@ada"), messageRecord(2, "@bea", "@bea")],
              };
            return {
              protocolMajor: 1,
              idempotencyKey: request.idempotencyKey,
              accepted: true,
              attentionCount: 0,
              hasMore: false,
              messages: [],
            };
          },
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
    );
    await runtime.start(connection);
    await runtime.startAgent("agent-a", config);
    await runtime.handleAgentMessage({
      protocolMajor: 1,
      requestId: "delivery-1",
      messageId: "message-1",
      deliveryId: "delivery-1",
      sequence: 1,
      workspaceId: connection.workspaceId,
      conversationId: "conversation-a",
      agentId: "agent-a",
      body: "body-1",
      method: "agent:v1:message:deliver",
      target: "@ada",
    });
    await runtime.handleAgentMessage({
      protocolMajor: 1,
      requestId: "delivery-untouched",
      messageId: "message-untouched",
      deliveryId: "delivery-untouched",
      sequence: 9,
      workspaceId: connection.workspaceId,
      conversationId: "conversation-b",
      agentId: "agent-a",
      body: "body-9",
      method: "agent:v1:message:deliver",
      target: "@carl",
    });
    const context = runtime.issueAgentContext("agent-a");
    const result = await runtime.agentMessage(
      context,
      { idempotencyKey: "check-drain", context, operation: "check", limit: 2 },
      `sk_agent_${"a".repeat(43)}`,
    );
    expect(limits).toEqual([2, 2]);
    expect(result.messages.map(({ id }) => id)).toEqual(["message-1", "message-2"]);
    expect(result.hasMore).toBe(false);
    const second = await runtime.agentMessage(
      context,
      { idempotencyKey: "check-after", context, operation: "check" },
      `sk_agent_${"a".repeat(43)}`,
    );
    expect(second.summaries.map((s) => s.target)).toEqual(["@ada", "@carl"]);
    await runtime.stop();
  });
  test("message check forwards --target on every events drain round", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const targets: string[] = [];
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        createAgentSession: async () => ({ ...sessionSpy(), async notify() {} }),
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async stop() {},
          async requestAgentLaunchConfig() {
            return agentLaunchConfig(`sk_agent_${"a".repeat(43)}`);
          },
          async revokeAgentApiKey() {},
          async sendAgentDeliveryAck() {},
          async agentMessage(request) {
            targets.push(request.target);
            return {
              protocolMajor: 1,
              idempotencyKey: request.idempotencyKey,
              accepted: true,
              attentionCount: 0,
              hasMore: false,
              messages: [],
            };
          },
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
    );
    await runtime.start(connection);
    await runtime.startAgent("agent-a", config);
    const context = runtime.issueAgentContext("agent-a");
    await runtime.agentMessage(
      context,
      { idempotencyKey: "check-target", context, operation: "check", target: "@ada" },
      `sk_agent_${"a".repeat(43)}`,
    );
    expect(targets).toEqual(["@ada"]);
    await runtime.stop();
  });
  test("a held draft survives restart without a read", async () => {
    const stateDirectory = join(tempRoot, `coforge-message-drafts-${crypto.randomUUID()}`);
    await seedCursor(
      "agent-a",
      {
        targets: { "@ada": { conversationId: "conversation-b", readOrder: 1 } },
        aliases: {},
        nextReadOrder: 1,
      },
      stateDirectory,
    );
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const operations: string[] = [];
    const messageRequests: Array<{
      idempotencyKey: string;
      draftReholdCount?: number;
      seenUpToSeq?: number;
    }> = [];
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        createAgentSession: async () => ({ ...sessionSpy(), async notify() {} }),
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async stop() {},
          async requestAgentApiKey() {
            return `sk_agent_${"a".repeat(43)}`;
          },
          async revokeAgentApiKey() {},
          async sendAgentDeliveryAck() {},
          async agentMessage(request) {
            operations.push(request.operation);
            messageRequests.push({
              idempotencyKey: request.idempotencyKey,
              draftReholdCount: request.draftReholdCount,
              seenUpToSeq: request.seenUpToSeq,
            });
            return request.idempotencyKey === "send-1"
              ? {
                  protocolMajor: 1,
                  idempotencyKey: request.idempotencyKey,
                  accepted: false,
                  attentionCount: 1,
                  state: "held" as const,
                  decision: "local_hold" as const,
                  reason: "exact_target_pending",
                  continueAnywaySuggested: true,
                  newMessageCount: 1,
                  shownMessageCount: 1,
                  omittedMessageCount: 0,
                  seenUpToSeq: 7,
                  writeConsumptionScope: { conversationId: "conversation-b" },
                  messages: [
                    {
                      id: "message-7",
                      sequence: 7,
                      senderKind: "human",
                      senderHandle: "ada",
                      senderDescription: "",
                      target: "@agent",
                      body: "new context",
                      createdAt: "2026-09-03T00:00:00Z",
                      attachments: [],
                    },
                  ],
                }
              : {
                  protocolMajor: 1,
                  idempotencyKey: request.idempotencyKey,
                  accepted: true,
                  attentionCount: 0,
                  state: "sent" as const,
                  decision: "forward" as const,
                  messageId: "sent",
                  messages: [],
                };
          },
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
      stateDirectory,
    );
    await runtime.start(connection);
    await runtime.startAgent("agent-a", config);
    const context = runtime.issueAgentContext("agent-a");
    await runtime.handleAgentMessage({
      protocolMajor: 1,
      requestId: "delivery-request",
      messageId: "message-7",
      deliveryId: "delivery-7",
      sequence: 7,
      workspaceId: connection.workspaceId,
      conversationId: "conversation-a",
      agentId: "agent-a",
      body: "new context",
      method: "agent:v1:message:deliver",
      target: "#general",
    });
    const held = await runtime.agentMessage(
      context,
      { idempotencyKey: "send-1", context, operation: "send", target: "@ada", content: "reply" },
      `sk_agent_${"a".repeat(43)}`,
    );
    expect(held).toMatchObject({
      accepted: false,
      state: "held",
      decision: "local_hold",
      messages: [{ id: "message-7" }],
    });
    expect(held).not.toHaveProperty("seenUpToSeq");
    expect(held).not.toHaveProperty("holdToken");
    expect(operations).toEqual(["send"]);
    expect(messageRequests).toEqual([
      { idempotencyKey: "send-1", draftReholdCount: 0, seenUpToSeq: undefined },
    ]);
    await runtime.stop();
    const recoveredRuntime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        createAgentSession: async () => ({ ...sessionSpy(), async notify() {} }),
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async stop() {},
          async requestAgentApiKey() {
            return `sk_agent_${"b".repeat(43)}`;
          },
          async revokeAgentApiKey() {},
          async sendAgentDeliveryAck() {},
          async agentMessage(request) {
            operations.push(request.operation);
            messageRequests.push({
              idempotencyKey: request.idempotencyKey,
              draftReholdCount: request.draftReholdCount,
              seenUpToSeq: request.seenUpToSeq,
            });
            return {
              protocolMajor: 1,
              idempotencyKey: request.idempotencyKey,
              accepted: true,
              attentionCount: 0,
              state: "sent" as const,
              decision: "forward" as const,
              messageId: "sent",
              messages: [],
            };
          },
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
      stateDirectory,
    );
    await recoveredRuntime.start(connection);
    await recoveredRuntime.startAgent("agent-a", config);
    const recoveredContext = recoveredRuntime.issueAgentContext("agent-a");
    const sent = await recoveredRuntime.agentMessage(
      recoveredContext,
      {
        idempotencyKey: "send-2",
        context: recoveredContext,
        operation: "send",
        target: "@ada",
        sendDraft: true,
      },
      `sk_agent_${"a".repeat(43)}`,
    );
    expect(sent).toMatchObject({ accepted: true, decision: "forward" });
    expect(operations).toEqual(["send", "send"]);
    expect(messageRequests).toEqual([
      { idempotencyKey: "send-1", draftReholdCount: 0, seenUpToSeq: undefined },
      { idempotencyKey: "send-1", draftReholdCount: 1, seenUpToSeq: undefined },
    ]);
    await expect(
      recoveredRuntime.agentMessage(
        recoveredContext,
        {
          idempotencyKey: "send-cleared",
          context: recoveredContext,
          operation: "send",
          target: "@ada",
          sendDraft: true,
        },
        `sk_agent_${"a".repeat(43)}`,
      ),
    ).rejects.toThrow("No saved draft");
    const ordinarySend = await recoveredRuntime.agentMessage(
      recoveredContext,
      {
        idempotencyKey: "send-3",
        context: recoveredContext,
        operation: "send",
        target: "@ada",
        content: "follow-up",
      },
      `sk_agent_${"a".repeat(43)}`,
    );
    expect(ordinarySend).toMatchObject({ accepted: true, decision: "forward" });
    expect(operations).toEqual(["send", "send", "send"]);
    expect(messageRequests.at(-1)).toEqual({
      idempotencyKey: "send-3",
      draftReholdCount: 0,
      seenUpToSeq: undefined,
    });
    await recoveredRuntime.stop();
    await rm(stateDirectory, { recursive: true, force: true });
  });
  test("a withheld send forwards the mode, redacts bodies locally, and prefers the server's count", async () => {
    const requests: AgentMessageRequest[] = [];
    const harness = await messageHarness(async (request) => {
      requests.push(request);
      return {
        protocolMajor: 1,
        idempotencyKey: request.idempotencyKey,
        accepted: false,
        attentionCount: 3,
        messages: [messageRecord(9, "@ada", "@ada")],
        state: "held",
        decision: "local_hold" as const,
        freshnessContextMode: "withheld" as const,
        ...(request.idempotencyKey === "send-server-count" ? { withheldMessageCount: 5 } : {}),
      };
    });
    try {
      const noServerCount = await harness.runtime.agentMessage(
        harness.context,
        {
          idempotencyKey: "send-no-server-count",
          context: harness.context,
          operation: "send",
          target: "@ada",
          content: "reply",
          freshnessContextMode: "withheld",
        },
        harness.apiKey,
      );
      expect(noServerCount).toMatchObject({
        messages: [],
        freshnessContextMode: "withheld",
        withheldMessageCount: 3,
      });
      const withServerCount = await harness.runtime.agentMessage(
        harness.context,
        {
          idempotencyKey: "send-server-count",
          context: harness.context,
          operation: "send",
          target: "@ada",
          content: "reply",
          freshnessContextMode: "withheld",
        },
        harness.apiKey,
      );
      expect(withServerCount).toMatchObject({
        messages: [],
        freshnessContextMode: "withheld",
        withheldMessageCount: 5,
      });
      expect(requests).toHaveLength(2);
      for (const request of requests)
        expect(request).toMatchObject({ operation: "send", freshnessContextMode: "withheld" });
    } finally {
      await harness.runtime.stop();
    }
  });
  test("keeps an Agent active without a process, wakes it for a message, and deactivates it", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const exits = new Set<() => void>();
    const statuses: import("@lrm/coforge-sdk/internal").AgentStatus[] = [];
    const notices: string[] = [];
    const acknowledgements: string[] = [];
    let starts = 0;
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        createAgentSession: async () => ({
          ...sessionSpy(),
          notify: async (notice) => {
            notices.push(notice);
          },
          onExit(listener) {
            exits.add(listener);
            return () => exits.delete(listener);
          },
        }),
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          sendAgentStatus(status) {
            statuses.push(status);
          },
          async sendAgentDeliveryAck(ack) {
            acknowledgements.push(ack.deliveryId);
          },
          async requestAgentApiKey() {
            starts++;
            return `sk_agent_${"a".repeat(43)}`;
          },
          async revokeAgentApiKey() {},
          async stop() {},
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
    );
    await runtime.start(connection);
    await runtime.startAgent("agent-a", config);
    expect(statuses.map(({ agentId, status }) => ({ agentId, status }))).toEqual([
      { agentId: "agent-a", status: "active" },
    ]);
    for (const exit of exits) exit();
    expect(statuses.map(({ agentId, status }) => ({ agentId, status }))).toEqual([
      { agentId: "agent-a", status: "active" },
    ]);
    expect(runtime.agentProcessManager.session("agent-a")).toBeUndefined();
    await runtime.handleAgentMessage({
      protocolMajor: 1,
      requestId: "message-request-1",
      messageId: "message-1",
      deliveryId: "delivery-1",
      sequence: 1,
      workspaceId: connection.workspaceId,
      conversationId: "conversation-1",
      agentId: "agent-a",
      body: "private body",
      method: "agent:v1:message:deliver",
      target: "@agent",
    });
    expect(starts).toBe(2);
    expect(notices.filter((notice) => !notice.includes("not a request"))).toEqual([
      "[CoForge inbox notice:\n@agent 1 new message]",
    ]);
    expect(acknowledgements).toEqual(["delivery-1"]);
    await runtime.stopAgent("agent-a");
    expect(statuses.at(-1)?.status).toBe("inactive");
    await runtime.stop();
  });
  test("acknowledges a message the Agent has already seen without waking its exited process", async () => {
    const stateDirectory = await seedReviewedDelivery(workspaceRoot);
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const exits = new Set<() => void>();
    const acknowledgements: string[] = [];
    let launches = 0;
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        createAgentSession: async () => {
          launches++;
          return {
            ...sessionSpy(),
            onExit(listener) {
              exits.add(listener);
              return () => exits.delete(listener);
            },
          };
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          sendAgentStatus() {},
          async sendAgentDeliveryAck(ack) {
            acknowledgements.push(ack.deliveryId);
          },
          async requestAgentApiKey() {
            return `sk_agent_${"a".repeat(43)}`;
          },
          async revokeAgentApiKey() {},
          async stop() {},
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
      stateDirectory,
    );
    try {
      await runtime.start(connection);
      await runtime.startAgent("agent-a", config);
      for (const exit of exits) exit();
      expect(runtime.agentProcessManager.session("agent-a")).toBeUndefined();
      await runtime.handleAgentMessage({
        protocolMajor: 1,
        requestId: "message-request-3",
        messageId: "message-3",
        deliveryId: "delivery-3",
        sequence: 3,
        workspaceId: connection.workspaceId,
        conversationId: "conversation-1",
        agentId: "agent-a",
        body: "already reviewed",
        method: "agent:v1:message:deliver",
        target: "@agent",
      });
      expect(acknowledgements).toEqual(["delivery-3"]);
      expect(launches).toBe(1);
      expect(runtime.agentProcessManager.session("agent-a")).toBeUndefined();
    } finally {
      await runtime.stop();
    }
  });
  test("rejects a delivery as no_process when the Agent has no process, no launch, and nothing to relaunch", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const acknowledgements: string[] = [];
    const rejections: import("@lrm/coforge-sdk/internal").AgentMessageDeliveryRejection[] = [];
    let launches = 0;
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        createAgentSession: async () => {
          launches++;
          return sessionSpy();
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          sendAgentStatus() {},
          async sendAgentDeliveryAck(ack) {
            acknowledgements.push(ack.deliveryId);
          },
          async sendAgentDeliveryRejection(rejection) {
            rejections.push(rejection);
          },
          async requestAgentApiKey() {
            return `sk_agent_${"a".repeat(43)}`;
          },
          async revokeAgentApiKey() {},
          async stop() {},
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
    );
    try {
      await runtime.start(connection);
      await runtime.handleAgentMessage({
        protocolMajor: 1,
        requestId: "message-request-4",
        messageId: "message-4",
        deliveryId: "delivery-4",
        sequence: 4,
        workspaceId: connection.workspaceId,
        conversationId: "conversation-1",
        agentId: "agent-a",
        body: "nobody is running",
        method: "agent:v1:message:deliver",
        target: "@agent",
      });
      expect(rejections).toEqual([
        {
          protocolMajor: 1,
          requestId: "message-request-4",
          messageId: "message-4",
          deliveryId: "delivery-4",
          workspaceId: connection.workspaceId,
          agentId: "agent-a",
          sequence: 4,
          reason: "no_process",
          method: "agent:v1:message:reject",
        },
      ]);
      expect(acknowledgements).toEqual([]);
      expect(launches).toBe(0);
    } finally {
      await runtime.stop();
    }
  });
  test("rejects the deliveries a lifted runner hold left queued for an Agent with no process", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const acknowledgements: string[] = [];
    const rejections: string[] = [];
    const runtime = new DaemonRuntime(
      connection,
      () => ({ provider: "pi", createAgentSession: async () => sessionSpy() }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          sendAgentStatus() {},
          async sendAgentDeliveryAck(ack) {
            acknowledgements.push(ack.deliveryId);
          },
          async sendAgentDeliveryRejection(rejection) {
            rejections.push(rejection.deliveryId);
          },
          async requestAgentApiKey() {
            return `sk_agent_${"a".repeat(43)}`;
          },
          async revokeAgentApiKey() {},
          async stop() {},
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
    );
    const deliver = (sequence: number) =>
      runtime.handleAgentMessage({
        protocolMajor: 1,
        requestId: `message-request-${sequence}`,
        messageId: `message-${sequence}`,
        deliveryId: `delivery-${sequence}`,
        sequence,
        workspaceId: connection.workspaceId,
        conversationId: "conversation-1",
        agentId: "agent-a",
        body: "nobody is running",
        method: "agent:v1:message:deliver",
        target: "@agent",
      });
    try {
      await runtime.start(connection);
      runtime.holdRunners(RUNNER_HOLD_REASONS.WORKSPACE_RESTART);
      await deliver(5);
      runtime.releaseRunners();
      await deliver(6);
      expect(rejections).toEqual(["delivery-5", "delivery-6"]);
      expect(acknowledgements).toEqual([]);
    } finally {
      await runtime.stop();
    }
  });
  async function pendingStartHarness(failures: number) {
    const stateDirectory = join(tempRoot, `coforge-start-buffer-${crypto.randomUUID()}`);
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const acknowledgements: string[] = [];
    const rejections: string[] = [];
    const notices: string[] = [];
    let acknowledged: () => void = () => {};
    const firstAck = new Promise<void>((resolve) => (acknowledged = resolve));
    let launches = 0;
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async createAgentSession() {
          launches++;
          if (launches <= failures) throw new Error("spawn failed");
          return {
            ...sessionSpy(),
            notify: async (notice) => {
              notices.push(notice);
            },
            readSessionIdentity: async () => ({ sessionId: "session-a", state: "empty" }),
          };
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async stop() {},
          sendAgentStatus() {},
          async requestAgentLaunchConfig() {
            return agentLaunchConfig(`sk_agent_${"a".repeat(43)}`);
          },
          async revokeAgentApiKey() {},
          async sendAgentControlResult() {},
          async reportAgentSession() {},
          async sendAgentDeliveryAck(ack) {
            acknowledgements.push(ack.deliveryId);
            acknowledged();
          },
          async sendAgentDeliveryRejection(rejection) {
            rejections.push(rejection.deliveryId);
          },
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
      stateDirectory,
    );
    await runtime.start(connection);
    const start = {
      protocolMajor: 1,
      requestId: "server-start",
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      agentId: "agent-a",
      ...config,
      controlEpoch: 1,
      launchId: "launch-1",
    };
    return {
      runtime,
      acknowledgements,
      rejections,
      notices,
      firstAck,
      start: () => runtime.handleAgentStart(start),
      stop: () =>
        runtime.handleAgentStop({
          protocolMajor: 1,
          requestId: "server-stop",
          workspaceId: connection.workspaceId,
          computerId: connection.computerId,
          agentId: "agent-a",
          provider: config.provider,
          controlEpoch: 2,
        }),
      deliver: (sequence: number) =>
        runtime.handleAgentMessage({
          protocolMajor: 1,
          requestId: `message-request-${sequence}`,
          messageId: `message-${sequence}`,
          deliveryId: `delivery-${sequence}`,
          sequence,
          workspaceId: connection.workspaceId,
          conversationId: "conversation-1",
          agentId: "agent-a",
          body: "while starting",
          method: "agent:v1:message:deliver",
          target: "@agent",
        }),
    };
  }
  test("holds a delivery that arrives while a server Start is being set up, unacknowledged, and presents it once the Agent launches", async () => {
    const h = await pendingStartHarness(0);
    try {
      const starting = h.start();
      await h.deliver(7);
      expect(h.rejections).toEqual([]);
      expect(h.acknowledgements).toEqual([]);
      await starting;
      await h.firstAck;
      expect(h.acknowledgements).toEqual(["delivery-7"]);
      expect(h.notices.some((notice) => notice.includes("@agent"))).toBe(true);
      expect(h.rejections).toEqual([]);
    } finally {
      await h.runtime.stop();
    }
  });
  test("holds a delivery that arrives during a server Start's launch-retry cooldown until the retry launches", async () => {
    const h = await pendingStartHarness(1);
    try {
      await h.start().catch(() => {});
      await h.deliver(8);
      expect(h.rejections).toEqual([]);
      expect(h.acknowledgements).toEqual([]);
      await h.firstAck;
      expect(h.acknowledgements).toEqual(["delivery-8"]);
      expect(h.rejections).toEqual([]);
    } finally {
      await h.runtime.stop();
    }
  });
  test("drops, unacknowledged and unrejected, what a server Start held when it ends without a launch", async () => {
    const h = await pendingStartHarness(Number.POSITIVE_INFINITY);
    try {
      await h.start().catch(() => {});
      await h.deliver(9);
      await h.stop();
      expect(h.acknowledgements).toEqual([]);
      expect(h.rejections).toEqual([]);
      await h.deliver(10);
      expect(h.rejections).toEqual(["delivery-10"]);
    } finally {
      await h.runtime.stop();
    }
  });
  test("acknowledges, rather than rejects, a message an Agent with no process has already seen", async () => {
    const stateDirectory = await seedReviewedDelivery(workspaceRoot);
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const acknowledgements: string[] = [];
    const rejections: string[] = [];
    const runtime = new DaemonRuntime(
      connection,
      () => ({ provider: "pi", createAgentSession: async () => sessionSpy() }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          sendAgentStatus() {},
          async sendAgentDeliveryAck(ack) {
            acknowledgements.push(ack.deliveryId);
          },
          async sendAgentDeliveryRejection(rejection) {
            rejections.push(rejection.deliveryId);
          },
          async requestAgentApiKey() {
            return `sk_agent_${"a".repeat(43)}`;
          },
          async revokeAgentApiKey() {},
          async stop() {},
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
      stateDirectory,
    );
    try {
      await runtime.start(connection);
      await runtime.handleAgentMessage({
        protocolMajor: 1,
        requestId: "message-request-3",
        messageId: "message-3",
        deliveryId: "delivery-3",
        sequence: 3,
        workspaceId: connection.workspaceId,
        conversationId: "conversation-1",
        agentId: "agent-a",
        body: "already reviewed",
        method: "agent:v1:message:deliver",
        target: "@agent",
      });
      expect(acknowledgements).toEqual(["delivery-3"]);
      expect(rejections).toEqual([]);
    } finally {
      await runtime.stop();
    }
  });
  test("another Agent's channel chatter that does not mention an exited Agent wakes it like a person's", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const exits = new Set<() => void>();
    const acknowledgements: string[] = [];
    const notices: string[] = [];
    let launches = 0;
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        createAgentSession: async () => {
          launches++;
          return {
            ...sessionSpy(),
            notify: async (notice) => {
              notices.push(notice);
            },
            onExit(listener) {
              exits.add(listener);
              return () => exits.delete(listener);
            },
          };
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          sendAgentStatus() {},
          async sendAgentDeliveryAck(ack) {
            acknowledgements.push(ack.deliveryId);
          },
          async requestAgentApiKey() {
            return `sk_agent_${"a".repeat(43)}`;
          },
          async revokeAgentApiKey() {},
          async stop() {},
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
    );
    try {
      await runtime.start(connection);
      await runtime.startAgent("agent-a", config);
      for (const exit of exits) exit();
      await runtime.handleAgentMessage({
        protocolMajor: 1,
        requestId: "message-request-chatter",
        messageId: "message-chatter",
        deliveryId: "delivery-chatter",
        sequence: 1,
        workspaceId: connection.workspaceId,
        conversationId: "conversation-team",
        agentId: "agent-a",
        body: "status update",
        method: "agent:v1:message:deliver",
        target: "#team",
        latestSenderKind: "agent",
        latestSenderHandle: "builder",
        mentionsAgent: false,
      });
      expect(acknowledgements).toEqual(["delivery-chatter"]);
      expect(launches).toBe(2);
      expect(notices.filter((notice) => !notice.includes("not a request"))).toHaveLength(1);
      expect(notices.find((notice) => notice.includes("#team 1 new message"))).toBeDefined();
    } finally {
      await runtime.stop();
    }
  });
  test("messages that arrive while a wake launch is in flight join its single notice, even across a failed launch", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const exits = new Set<() => void>();
    const events: string[] = [];
    let allAcknowledged!: () => void;
    const acknowledged = new Promise<void>((resolve) => {
      allAcknowledged = resolve;
    });
    let launchAttempts = 0;
    let failLaunch!: (error: Error) => void;
    let wakeLaunchStarted!: () => void;
    const wakeLaunching = new Promise<void>((resolve) => {
      wakeLaunchStarted = resolve;
    });
    let retryLaunchStarted!: () => void;
    const retryLaunching = new Promise<void>((resolve) => {
      retryLaunchStarted = resolve;
    });
    const retryLaunch = Promise.withResolvers<void>();
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        createAgentSession: async () => {
          launchAttempts++;
          if (launchAttempts === 2)
            await new Promise<never>((_, reject) => {
              failLaunch = reject;
              wakeLaunchStarted();
            });
          if (launchAttempts === 3) {
            retryLaunchStarted();
            await retryLaunch.promise;
          }
          return {
            ...sessionSpy(),
            notify: async (notice) => {
              events.push(`notice ${notice.match(/@agent (\d+) new messages?/)?.[1]}`);
              allAcknowledged();
            },
            onExit(listener) {
              exits.add(listener);
              return () => exits.delete(listener);
            },
          };
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          sendAgentStatus() {},
          async sendAgentDeliveryAck(ack) {
            events.push(`ack ${ack.deliveryId}`);
          },
          async requestAgentApiKey() {
            return `sk_agent_${"a".repeat(43)}`;
          },
          async revokeAgentApiKey() {},
          async stop() {},
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
    );
    const delivery = (sequence: number) => ({
      protocolMajor: 1 as const,
      requestId: `message-request-${sequence}`,
      messageId: `message-${sequence}`,
      deliveryId: `delivery-${sequence}`,
      sequence,
      workspaceId: connection.workspaceId,
      conversationId: "conversation-1",
      agentId: "agent-a",
      body: `body ${sequence}`,
      method: "agent:v1:message:deliver" as const,
      target: "@agent",
    });
    try {
      await runtime.start(connection);
      await runtime.startAgent("agent-a", config);
      for (const exit of exits) exit();
      const first = runtime.handleAgentMessage(delivery(1));
      void first.catch(() => {});
      await wakeLaunching;
      const second = runtime.handleAgentMessage(delivery(2));
      void second.catch(() => {});
      failLaunch(new Error("pi: command not found"));
      await expect(first).rejects.toThrow("pi: command not found");
      await expect(second).resolves.toBeUndefined();
      expect(events).toEqual(["ack delivery-1", "ack delivery-2"]);
      await Bun.sleep(1100);
      const third = runtime.handleAgentMessage(delivery(3));
      await retryLaunching;
      await runtime.handleAgentMessage(delivery(4));
      retryLaunch.resolve();
      await third;
      await acknowledged;
      expect(launchAttempts).toBe(3);
      expect(events).toEqual([
        "ack delivery-1",
        "ack delivery-2",
        "ack delivery-3",
        "ack delivery-4",
        "notice 4",
      ]);
    } finally {
      await runtime.stop();
    }
  });
  test("a message that arrives while a recovery Start is in flight is not acknowledged by that recovery", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const exits = new Set<() => void>();
    const events: string[] = [];
    let launchAttempts = 0;
    const recoveryLaunch = Promise.withResolvers<void>();
    const recoveryLaunching = Promise.withResolvers<void>();
    const fourthAcknowledged = Promise.withResolvers<void>();
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        createAgentSession: async () => {
          launchAttempts++;
          if (launchAttempts === 2) throw new Error("pi: command not found");
          if (launchAttempts === 3) {
            recoveryLaunching.resolve();
            await recoveryLaunch.promise;
          }
          return {
            ...sessionSpy(),
            notify: async (notice) => {
              if (!notice.includes("not a request")) events.push("notice");
            },
            onExit(listener) {
              exits.add(listener);
              return () => exits.delete(listener);
            },
          };
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          sendAgentStatus() {},
          async sendAgentDeliveryAck(ack) {
            events.push(`ack ${ack.deliveryId}`);
            if (ack.deliveryId === "delivery-4") fourthAcknowledged.resolve();
          },
          async requestAgentApiKey() {
            return `sk_agent_${"a".repeat(43)}`;
          },
          async revokeAgentApiKey() {},
          async stop() {},
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
    );
    const delivery = (sequence: number) => ({
      protocolMajor: 1 as const,
      requestId: `message-request-${sequence}`,
      messageId: `message-${sequence}`,
      deliveryId: `delivery-${sequence}`,
      sequence,
      workspaceId: connection.workspaceId,
      conversationId: "conversation-1",
      agentId: "agent-a",
      body: `body ${sequence}`,
      method: "agent:v1:message:deliver" as const,
      target: "@agent",
    });
    try {
      await runtime.start(connection);
      await runtime.startAgent("agent-a", config);
      for (const exit of exits) exit();
      await expect(runtime.handleAgentMessage(delivery(1))).rejects.toThrow(
        "pi: command not found",
      );
      const started = runtime.startAgent("agent-a", config, undefined, undefined, {
        resumeMessages: [
          {
            messageId: "message-1",
            deliveryId: "delivery-1",
            conversationId: "conversation-1",
            sequence: 1,
            target: "@agent",
            latestSenderKind: "human" as const,
            latestSenderHandle: "ada",
            latestSenderDescription: "",
            body: "body 1",
          },
        ],
        unreadSummary: {},
      });
      await recoveryLaunching.promise;
      const fourth = runtime.handleAgentMessage(delivery(4));
      void fourth.catch(() => {});
      recoveryLaunch.resolve();
      await started;
      await fourthAcknowledged.promise;
      const fourthAck = events.indexOf("ack delivery-4");
      expect(events.slice(0, fourthAck).filter((event) => event === "notice")).toHaveLength(2);
    } finally {
      await runtime.stop();
    }
  });
  test("a successful Start clears the wake cooldown a failed wake launch left behind", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const exits = new Set<() => void>();
    let launchAttempts = 0;
    let broken = false;
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        createAgentSession: async () => {
          launchAttempts++;
          if (broken) throw new Error("pi: command not found");
          return {
            ...sessionSpy(),
            notify: async () => {},
            onExit(listener) {
              exits.add(listener);
              return () => exits.delete(listener);
            },
          };
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          sendAgentStatus() {},
          async sendAgentDeliveryAck() {},
          async requestAgentApiKey() {
            return `sk_agent_${"a".repeat(43)}`;
          },
          async revokeAgentApiKey() {},
          async stop() {},
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
    );
    const delivery = (sequence: number) => ({
      protocolMajor: 1 as const,
      requestId: `message-request-${sequence}`,
      messageId: `message-${sequence}`,
      deliveryId: `delivery-${sequence}`,
      sequence,
      workspaceId: connection.workspaceId,
      conversationId: "conversation-1",
      agentId: "agent-a",
      body: `body ${sequence}`,
      method: "agent:v1:message:deliver" as const,
      target: "@agent",
    });
    const exitAll = () => {
      for (const exit of exits) exit();
      exits.clear();
    };
    try {
      await runtime.start(connection);
      await runtime.startAgent("agent-a", config);
      exitAll();
      broken = true;
      await expect(runtime.handleAgentMessage(delivery(1))).rejects.toThrow(
        "pi: command not found",
      );
      broken = false;
      await runtime.startAgent("agent-a", config);
      exitAll();
      const beforeWake = launchAttempts;
      await runtime.handleAgentMessage(delivery(2));
      expect(launchAttempts).toBe(beforeWake + 1);
      expect(runtime.agentProcessManager.session("agent-a")).toBeDefined();
    } finally {
      await runtime.stop();
    }
  });
  test("an inbox purge drops the pending attention of the channels an Agent can no longer read", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        createAgentSession: async () => ({ ...sessionSpy(), notify: async () => {} }),
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          sendAgentStatus() {},
          async sendAgentDeliveryAck() {},
          async requestAgentApiKey() {
            return `sk_agent_${"a".repeat(43)}`;
          },
          async revokeAgentApiKey() {},
          async stop() {},
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
    );
    const channelDelivery = (sequence: number, target: string, conversationId: string) => ({
      protocolMajor: 1 as const,
      requestId: `message-request-${sequence}`,
      messageId: `message-${sequence}`,
      deliveryId: `delivery-${sequence}`,
      sequence,
      workspaceId: connection.workspaceId,
      conversationId,
      agentId: "agent-a",
      body: `body ${sequence}`,
      method: "agent:v1:message:deliver" as const,
      target,
      latestSenderKind: "human" as const,
      latestSenderHandle: "ada",
    });
    try {
      await runtime.start(connection);
      await runtime.startAgent("agent-a", config);
      const context = runtime.issueAgentContext("agent-a");
      await runtime.handleAgentMessage(channelDelivery(1, "#team", "conversation-team"));
      await runtime.handleAgentMessage(
        channelDelivery(2, "#team:123e4567-e89b-42d3-a456-426614174000", "conversation-team"),
      );
      await runtime.handleAgentMessage(channelDelivery(3, "#ops", "conversation-ops"));
      await runtime.handleAgentMessage(channelDelivery(4, "#teammates", "conversation-teammates"));
      const targets = async () =>
        (
          await runtime.inbox(context, {
            idempotencyKey: crypto.randomUUID(),
            context,
            operation: "check",
          })
        ).entries
          .flatMap((entry) => (entry.kind === "message_target" ? [entry.messageTarget.target] : []))
          .sort();
      expect(await targets()).toEqual([
        "#ops",
        "#team",
        "#team:123e4567-e89b-42d3-a456-426614174000",
        "#teammates",
      ]);
      runtime.handleAgentInboxPurge({
        protocolMajor: 1,
        requestId: "purge-1",
        workspaceId: connection.workspaceId,
        computerId: connection.computerId,
        agentId: "agent-a",
        conversationIds: ["conversation-team"],
        targets: ["#team"],
        reason: "member_removed",
      });
      expect(await targets()).toEqual(["#ops", "#teammates"]);
    } finally {
      await runtime.stop();
    }
  });
  test("an inbox purge drops waiting deliveries of a lost channel instead of announcing them", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const exits = new Set<() => void>();
    const events: string[] = [];
    let launchAttempts = 0;
    const wakeLaunch = Promise.withResolvers<void>();
    const wakeLaunching = Promise.withResolvers<void>();
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        createAgentSession: async () => {
          launchAttempts++;
          if (launchAttempts === 2) {
            wakeLaunching.resolve();
            await wakeLaunch.promise;
          }
          return {
            ...sessionSpy(),
            notify: async (notice) => {
              if (notice.includes("not a request")) return;
              events.push(`notice ${notice.match(/(\d+) new message/)?.[1]}`);
            },
            onExit(listener) {
              exits.add(listener);
              return () => exits.delete(listener);
            },
          };
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          sendAgentStatus() {},
          async sendAgentDeliveryAck(ack) {
            events.push(`ack ${ack.deliveryId}`);
          },
          async requestAgentApiKey() {
            return `sk_agent_${"a".repeat(43)}`;
          },
          async revokeAgentApiKey() {},
          async stop() {},
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
    );
    const delivery = (sequence: number, target: string, conversationId: string) => ({
      protocolMajor: 1 as const,
      requestId: `message-request-${sequence}`,
      messageId: `message-${sequence}`,
      deliveryId: `delivery-${sequence}`,
      sequence,
      workspaceId: connection.workspaceId,
      conversationId,
      agentId: "agent-a",
      body: `body ${sequence}`,
      method: "agent:v1:message:deliver" as const,
      target,
      latestSenderKind: "human" as const,
      latestSenderHandle: "ada",
    });
    try {
      await runtime.start(connection);
      await runtime.startAgent("agent-a", config);
      for (const exit of exits) exit();
      const dm = runtime.handleAgentMessage(delivery(1, "@ada", "conversation-dm"));
      await wakeLaunching.promise;
      const team = runtime.handleAgentMessage(delivery(2, "#team", "conversation-team"));
      runtime.handleAgentInboxPurge({
        protocolMajor: 1,
        requestId: "purge-1",
        workspaceId: connection.workspaceId,
        computerId: connection.computerId,
        agentId: "agent-a",
        conversationIds: ["conversation-team"],
        targets: ["#team"],
        reason: "left",
      });
      await expect(team).resolves.toBeUndefined();
      wakeLaunch.resolve();
      await dm;
      expect(events).toEqual(["ack delivery-2", "notice 1", "ack delivery-1"]);
    } finally {
      await runtime.stop();
    }
  });
  test("an inbox purge drops a lost channel's delivery kept for the next launch", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const exits = new Set<() => void>();
    const events: string[] = [];
    const acknowledged = Promise.withResolvers<void>();
    let launchAttempts = 0;
    const failingLaunch = Promise.withResolvers<void>();
    const failingLaunchStarted = Promise.withResolvers<void>();
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        createAgentSession: async () => {
          launchAttempts++;
          if (launchAttempts === 2) {
            failingLaunchStarted.resolve();
            await failingLaunch.promise;
            throw new Error("pi: command not found");
          }
          return {
            ...sessionSpy(),
            notify: async (notice) => {
              events.push(`notice ${notice.match(/(\d+) new message/)?.[1]}`);
              acknowledged.resolve();
            },
            onExit(listener) {
              exits.add(listener);
              return () => exits.delete(listener);
            },
          };
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          sendAgentStatus() {},
          async sendAgentDeliveryAck(ack) {
            events.push(`ack ${ack.deliveryId}`);
          },
          async requestAgentApiKey() {
            return `sk_agent_${"a".repeat(43)}`;
          },
          async revokeAgentApiKey() {},
          async stop() {},
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
    );
    const delivery = (sequence: number, target: string, conversationId: string) => ({
      protocolMajor: 1 as const,
      requestId: `message-request-${sequence}`,
      messageId: `message-${sequence}`,
      deliveryId: `delivery-${sequence}`,
      sequence,
      workspaceId: connection.workspaceId,
      conversationId,
      agentId: "agent-a",
      body: `body ${sequence}`,
      method: "agent:v1:message:deliver" as const,
      target,
      latestSenderKind: "human" as const,
      latestSenderHandle: "ada",
    });
    try {
      await runtime.start(connection);
      await runtime.startAgent("agent-a", config);
      for (const exit of exits) exit();
      const dm = runtime.handleAgentMessage(delivery(1, "@ada", "conversation-dm"));
      void dm.catch(() => {});
      await failingLaunchStarted.promise;
      const team = runtime.handleAgentMessage(delivery(2, "#team", "conversation-team"));
      failingLaunch.resolve();
      await expect(dm).rejects.toThrow("pi: command not found");
      await team;
      runtime.handleAgentInboxPurge({
        protocolMajor: 1,
        requestId: "purge-1",
        workspaceId: connection.workspaceId,
        computerId: connection.computerId,
        agentId: "agent-a",
        conversationIds: ["conversation-team"],
        targets: ["#team"],
        reason: "member_removed",
      });
      await runtime.startAgent("agent-a", config);
      await acknowledged.promise;
      expect(events).toEqual(["ack delivery-1", "ack delivery-2", "notice 1"]);
    } finally {
      await runtime.stop();
    }
  });
  test("reports active Agents inactive before a graceful daemon shutdown", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const statuses: import("@lrm/coforge-sdk/internal").AgentStatus[] = [];
    let statusAtTransportStop: string | undefined;
    const runtime = new DaemonRuntime(
      connection,
      () => ({ provider: "pi", createAgentSession: async () => sessionSpy() }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          sendAgentStatus(status) {
            statuses.push(status);
          },
          async requestAgentApiKey() {
            return `sk_agent_${"a".repeat(43)}`;
          },
          async revokeAgentApiKey() {},
          async stop() {
            statusAtTransportStop = statuses.at(-1)?.status;
          },
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
    );
    await runtime.start(connection);
    await runtime.startAgent("agent-a", config);
    await Bun.sleep(2);
    await runtime.stop();
    expect(statuses.map(({ status }) => status)).toEqual(["active", "inactive"]);
    expect(new Set(statuses.map(({ observedAtMs }) => observedAtMs)).size).toBe(1);
    expect(statusAtTransportStop).toBe("inactive");
  });
  test("reports runtimes without waiting for catalog discovery, then catalogs in a second update", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const updates: unknown[] = [];
    const secondUpdate = Promise.withResolvers<void>();
    const catalogDiscovery = Promise.withResolvers<{
      catalogs: {
        provider: "codex";
        models: never[];
      }[];
      failures: never[];
    }>();
    let catalogDiscoveryStarted = false;
    const runtime = new DaemonRuntime(
      connection,
      () => ({ provider: "pi", createAgentSession: async () => sessionSpy() }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async updateCodeAgents(request) {
            updates.push(request);
            if (updates.length === 2) secondUpdate.resolve();
          },
          async stop() {},
        }),
      },
      undefined,
      {
        runtimes: async () => [{ provider: "codex", version: "0.151.0", displayName: "Codex" }],
        cachedCatalogs: async () => ({ catalogs: [], needsRefresh: true }),
        catalogs: async () => {
          catalogDiscoveryStarted = true;
          return catalogDiscovery.promise;
        },
      },
    );
    await runtime.start(connection);
    await Bun.sleep(0);
    expect(catalogDiscoveryStarted).toBe(true);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      runtimes: [{ provider: "codex", version: "0.151.0", displayName: "Codex" }],
      catalogs: [],
    });
    catalogDiscovery.resolve({ catalogs: [{ provider: "codex", models: [] }], failures: [] });
    await secondUpdate.promise;
    expect(updates).toHaveLength(2);
    expect(updates[1]).toMatchObject({
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      runtimes: [{ provider: "codex", version: "0.151.0", displayName: "Codex" }],
      catalogs: [{ provider: "codex", models: [] }],
    });
    await runtime.stop();
  });
  test("skips the background catalog refresh when the cached catalogs are already fresh", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const updates: unknown[] = [];
    let catalogDiscoveryCalls = 0;
    const runtime = new DaemonRuntime(
      connection,
      () => ({ provider: "pi", createAgentSession: async () => sessionSpy() }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async updateCodeAgents(request) {
            updates.push(request);
          },
          async stop() {},
        }),
      },
      undefined,
      {
        runtimes: async () => [{ provider: "codex", version: "0.151.0", displayName: "Codex" }],
        cachedCatalogs: async () => ({
          catalogs: [{ provider: "codex", models: [] }],
          needsRefresh: false,
        }),
        catalogs: async () => {
          catalogDiscoveryCalls++;
          return { catalogs: [{ provider: "codex", models: [] }], failures: [] };
        },
      },
    );
    await runtime.start(connection);
    await Bun.sleep(2);
    expect(catalogDiscoveryCalls).toBe(0);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ catalogs: [{ provider: "codex", models: [] }] });
    await runtime.stop();
  });
  test("a reconnect re-reports Code Agent runtimes, then refreshes stale catalogs", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const runtimes = [{ provider: "codex" as const, version: "0.151.0", displayName: "Codex" }];
    const model = {
      displayName: "Model",
      description: "",
      modelProvider: "openai",
      reasoningEfforts: [],
      defaultReasoning: "",
      recommended: false,
    };
    const cachedCatalogs = [{ provider: "codex" as const, models: [{ ...model, id: "cached" }] }];
    const liveCatalogs = [{ provider: "codex" as const, models: [{ ...model, id: "live" }] }];
    const updates: Array<{
      requestId: string;
      [field: string]: unknown;
    }> = [];
    const startupReported = Promise.withResolvers<void>();
    const reconnectReported = Promise.withResolvers<void>();
    let reconnect: (() => void) | undefined;
    const catalogDiscoveryRuntimes: unknown[] = [];
    const runtime = new DaemonRuntime(
      connection,
      () => ({ provider: "pi", createAgentSession: async () => sessionSpy() }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async updateCodeAgents(request) {
            updates.push(request);
            if (updates.length === 2) startupReported.resolve();
            if (updates.length === 4) reconnectReported.resolve();
          },
          onReconnect(callback) {
            reconnect = callback;
            return () => {};
          },
          async stop() {},
        }),
      },
      undefined,
      {
        runtimes: async () => runtimes,
        cachedCatalogs: async () => ({ catalogs: cachedCatalogs, needsRefresh: true }),
        catalogs: async (discovered) => {
          catalogDiscoveryRuntimes.push(discovered);
          return { catalogs: liveCatalogs, failures: [] };
        },
      },
    );
    try {
      await runtime.start(connection);
      await startupReported.promise;
      expect(reconnect).toBeDefined();
      catalogDiscoveryRuntimes.length = 0;
      reconnect!();
      await reconnectReported.promise;
      const reconnectUpdates = updates.slice(2);
      expect(reconnectUpdates).toEqual([
        {
          protocolMajor: expect.any(Number),
          requestId: expect.any(String),
          workspaceId: connection.workspaceId,
          computerId: connection.computerId,
          runtimes,
          catalogs: cachedCatalogs,
        },
        {
          protocolMajor: expect.any(Number),
          requestId: expect.any(String),
          workspaceId: connection.workspaceId,
          computerId: connection.computerId,
          runtimes,
          catalogs: liveCatalogs,
        },
      ]);
      expect(catalogDiscoveryRuntimes).toEqual([runtimes]);
      expect(new Set(updates.map(({ requestId }) => requestId)).size).toBe(4);
    } finally {
      await runtime.stop();
    }
  });
  test.each(["empty", "unavailable"])(
    "falls back to a current Claude rate-limit observation when direct usage is %s",
    async (reading) => {
      const credentials = new InMemoryDaemonCredentialStore();
      await credentials.save(connection.workspaceId, connection.computerId, "token-a");
      const listeners = new Set<(event: AgentRuntimeEvent) => void>();
      const adapter: CodeAgentProvider = {
        provider: "claude-code",
        async readUsage() {
          if (reading === "unavailable") throw new UsageUnavailableError();
          return null;
        },
        async createAgentSession() {
          return {
            ...sessionSpy(),
            subscribe(listener) {
              listeners.add(listener);
              return () => listeners.delete(listener);
            },
          };
        },
      };
      const runtime = new DaemonRuntime(
        connection,
        () => adapter,
        credentials,
        {
          create: () => ({
            async start() {},
            async ready() {},
            async requestAgentLaunchConfig() {
              return agentLaunchConfig(`sk_agent_${"a".repeat(43)}`);
            },
            async stop() {},
          }),
        },
        undefined,
        emptyCodeAgentDiscovery,
      );
      try {
        await runtime.start(connection);
        await runtime.startAgent("agent-a", {
          provider: "claude-code",
          model: "claude-sonnet-5",
          reasoning: "high",
        });
        for (const listener of listeners)
          listener({
            type: AGENT_RUNTIME_EVENT_TYPE.USAGE,
            snapshot: {
              provider: "claude-code",
              primary: {
                status: "ok",
                windowDurationMinutes: 300,
                resetsAt: "2099-09-04T03:00:00.000Z",
              },
            },
          });
        const result = await runtime.scanUsage("claude-code");
        expect(result.status).toBe("available");
        const { collectedAt, ...snapshot } = JSON.parse(
          new TextDecoder().decode(result.snapshotJson),
        );
        expect(typeof collectedAt).toBe("string");
        expect(snapshot).toEqual({
          provider: "claude-code",
          primary: {
            status: "ok",
            windowDurationMinutes: 300,
            resetsAt: "2099-09-04T03:00:00.000Z",
          },
        });
      } finally {
        await runtime.stop();
      }
    },
  );
  test("an observed usage snapshot keeps the time it was observed, not the later scan time", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const listeners = new Set<(event: AgentRuntimeEvent) => void>();
    const adapter: CodeAgentProvider = {
      provider: "claude-code",
      async readUsage() {
        return null;
      },
      async createAgentSession() {
        return {
          ...sessionSpy(),
          subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        };
      },
    };
    const runtime = new DaemonRuntime(
      connection,
      () => adapter,
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async requestAgentLaunchConfig() {
            return agentLaunchConfig(`sk_agent_${"a".repeat(43)}`);
          },
          async stop() {},
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
    );
    try {
      await runtime.start(connection);
      await runtime.startAgent("agent-a", {
        provider: "claude-code",
        model: "claude-sonnet-5",
        reasoning: "high",
      });
      setSystemTime(new Date("2026-09-17T00:00:00.000Z"));
      for (const listener of listeners)
        listener({
          type: AGENT_RUNTIME_EVENT_TYPE.USAGE,
          snapshot: {
            provider: "claude-code",
            primary: {
              status: "ok",
              windowDurationMinutes: 300,
              resetsAt: "2099-09-04T03:00:00.000Z",
            },
          },
        });
      setSystemTime(new Date("2026-09-17T01:00:00.000Z"));
      const result = await runtime.scanUsage("claude-code");
      const { collectedAt } = JSON.parse(new TextDecoder().decode(result.snapshotJson));
      expect(collectedAt).toBe("2026-09-17T00:00:00.000Z");
    } finally {
      setSystemTime();
      await runtime.stop();
    }
  });
  test.each(["parse-failure", "command-failure"])(
    "a signed-in Claude with %s usage is unavailable instead of requiring sign-in",
    async (mode) => {
      const directory = await mkdtemp(join(tempRoot, "coforge-claude-usage-status-"));
      const modeFile = join(directory, "mode");
      const executable = join(directory, "claude.ts");
      const fixture = claudeUsageFixture;
      const credentials = new InMemoryDaemonCredentialStore();
      const provider = claudeProvider({ command: [executable] });
      const runtime = new DaemonRuntime(
        { ...connection, workspaceRoot: directory },
        () => provider,
        credentials,
        { create: () => ({ async start() {}, async ready() {}, async stop() {} }) },
        undefined,
        emptyCodeAgentDiscovery,
      );
      try {
        await Bun.write(
          executable,
          `#!${process.execPath}\nconst mode = await Bun.file(${JSON.stringify(modeFile)}).text();\nconst child = Bun.spawn([process.execPath, ${JSON.stringify(fixture)}, mode, ...Bun.argv.slice(2)], { stdin: "ignore", stdout: "inherit", stderr: "ignore" });\nconst code = await child.exited;\nprocess.exit(mode === "command-failure" && Bun.argv.includes("/usage") ? 1 : code);\n`,
        );
        await chmod(executable, 0o755);
        await credentials.save(connection.workspaceId, connection.computerId, "token-a");
        await Bun.write(modeFile, mode);
        await runtime.start({ ...connection, workspaceRoot: directory });
        expect(await runtime.scanUsage("claude-code")).toMatchObject({
          accepted: false,
          status: "unavailable",
          message: "Provider usage is unavailable",
        });
        await Bun.write(modeFile, "current");
        const available = await runtime.scanUsage("claude-code");
        expect(available.status).toBe("available");
        expect(JSON.parse(new TextDecoder().decode(available.snapshotJson))).toMatchObject({
          provider: "claude-code",
          primary: { usedPercent: 6 },
        });
        await Bun.write(modeFile, "logged-out");
        expect((await runtime.scanUsage("claude-code")).status).toBe("reauth");
      } finally {
        try {
          await runtime.stop();
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      }
    },
    6 * USAGE_SCAN_READ_TIMEOUT_MS + DAEMON_SHUTDOWN_NOTICE_TIMEOUT_MS,
  );
  test("scans Kiro quota and distinguishes an unrepresentable window from expired authentication", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const snapshot = {
      provider: "kiro" as const,
      primary: {
        usedPercent: 37,
        windowDurationMinutes: 43200,
        resetsAt: "2026-10-01T00:00:00.000Z",
      },
    };
    let outcome: "available" | "unavailable" | "reauth" = "available";
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "kiro",
        async readUsage() {
          if (outcome === "unavailable") throw new UsageUnavailableError();
          if (outcome === "reauth") return null;
          return snapshot;
        },
        async createAgentSession() {
          return sessionSpy();
        },
      }),
      credentials,
      { create: () => ({ async start() {}, async ready() {}, async stop() {} }) },
      undefined,
      emptyCodeAgentDiscovery,
    );
    await runtime.start(connection);
    try {
      const result = await runtime.scanUsage("kiro");
      expect(result.status).toBe("available");
      const { collectedAt, ...decoded } = JSON.parse(new TextDecoder().decode(result.snapshotJson));
      expect(typeof collectedAt).toBe("string");
      expect(decoded).toEqual(snapshot);
      outcome = "unavailable";
      expect((await runtime.scanUsage("kiro")).status).toBe("unavailable");
      outcome = "reauth";
      expect((await runtime.scanUsage("kiro")).status).toBe("reauth");
    } finally {
      await runtime.stop();
    }
  });
  test("does not expose a usage provider exception in the scan response", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "codex",
        async readUsage() {
          throw new Error("provider token secret at 127.0.0.1");
        },
        async createAgentSession() {
          return sessionSpy();
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async stop() {},
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
    );
    await runtime.start(connection);
    const result = await runtime.scanUsage("codex");
    expect(result).toMatchObject({ status: "error", message: "Usage scan failed" });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain("127.0.0.1");
    await runtime.stop();
  });
  test("passes the persisted server HTTP URL to the Agent API key client", async () => {
    const configuredConnection = {
      ...connection,
      serverHttpUrl: "https://server.example/api/internal/centrifugo",
    };
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "daemon-token");
    const requests: Array<{
      url: string;
      authorization: string | null;
    }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const url = String(input);
        if (url.startsWith("https://server.example/"))
          requests.push({ url, authorization: new Headers(init?.headers).get("authorization") });
        return Response.json({ apiKey: `sk_agent_${"a".repeat(43)}` });
      },
      { preconnect: originalFetch.preconnect },
    );
    const client = connectedClient();
    const runtime = new DaemonRuntime(
      configuredConnection,
      () => ({ provider: "pi", createAgentSession: async () => sessionSpy() }),
      credentials,
      {
        create: () => new DaemonConnection("wss://cloud.example", () => client),
      },
      undefined,
      emptyCodeAgentDiscovery,
    );
    try {
      await runtime.start(configuredConnection);
      await runtime.startAgent("agent-a", config);
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(requests).toEqual([
      {
        url: "https://server.example/api/agent-api-keys",
        authorization: "Bearer daemon-token",
      },
    ]);
  });
  test("shares concurrent starts and starts transport once", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let starts = 0;
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async createAgentSession() {
          return sessionSpy();
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {
            starts++;
            await gate;
          },
          async ready() {},
          async stop() {},
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
    );
    const first = runtime.start(connection);
    const second = runtime.start(connection);
    expect(second).toBe(first);
    release();
    await Promise.all([first, second]);
    await runtime.start(connection);
    expect(starts).toBe(1);
    await runtime.stop();
  });
  test("starts all ready publications without blocking other Agents on a slow launch", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const startedAgents: string[] = [];
    let releaseFirstCredential!: () => void;
    const firstCredential = new Promise<void>((resolve) => (releaseFirstCredential = resolve));
    let secondAgentActive!: () => void;
    const secondActive = new Promise<void>((resolve) => (secondAgentActive = resolve));
    let listener: ((intent: Parameters<DaemonRuntime["handleAgentStart"]>[0]) => void) | undefined;
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async createAgentSession(input) {
          startedAgents.push(input.sessionId ?? "");
          return sessionSpy();
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          onAgentStart(callback) {
            listener = callback;
            return () => {
              listener = undefined;
            };
          },
          async ready() {
            listener?.({
              protocolMajor: 1,
              requestId: "ready-publication-1",
              workspaceId: connection.workspaceId,
              computerId: connection.computerId,
              agentId: "agent-a",
              provider: "pi",
              model: "default",
              reasoning: "balanced",
              sessionId: "session-a",
            });
            listener?.({
              protocolMajor: 1,
              requestId: "ready-publication-2",
              workspaceId: connection.workspaceId,
              computerId: connection.computerId,
              agentId: "agent-b",
              provider: "pi",
              model: "default",
              reasoning: "balanced",
              sessionId: "session-b",
            });
          },
          async requestAgentLaunchConfig({ agentId }) {
            if (agentId === "agent-a") await firstCredential;
            return agentLaunchConfig(
              `sk_agent_${crypto.randomUUID().replaceAll("-", "").padEnd(43, "a")}`,
            );
          },
          sendAgentStatus({ agentId, status }) {
            if (agentId === "agent-b" && status === "active") secondAgentActive();
          },
          async sendAgentActivity() {},
          async stop() {},
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
    );
    const starting = runtime.start(connection);
    try {
      await secondActive;
      expect(startedAgents).toEqual(["session-b"]);
      releaseFirstCredential();
      await starting;
      expect(startedAgents).toEqual(["session-b", "session-a"]);
    } finally {
      releaseFirstCredential();
      await starting;
      await runtime.stop();
    }
  });
  test("flushes buffered starts before delivery without losing starts received during flush", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    let startListener:
      | ((intent: Parameters<DaemonRuntime["handleAgentStart"]>[0]) => void)
      | undefined;
    let messageListener:
      | ((message: Parameters<DaemonRuntime["handleAgentMessage"]>[0]) => void)
      | undefined;
    const events: string[] = [];
    let notifyStarted!: () => void;
    const notifying = new Promise<void>((resolve) => (notifyStarted = resolve));
    let releaseNotify!: () => void;
    const notifyGate = new Promise<void>((resolve) => (releaseNotify = resolve));
    let releaseSecondCredential!: () => void;
    const secondCredential = new Promise<void>((resolve) => (releaseSecondCredential = resolve));
    let secondAgentActive!: () => void;
    const secondActive = new Promise<void>((resolve) => (secondAgentActive = resolve));
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        createAgentSession: async ({ agentId }) => {
          events.push(`start:${agentId}`);
          return {
            ...sessionSpy(),
            async notify() {
              events.push(`notify:${agentId}`);
              notifyStarted();
              await notifyGate;
            },
          };
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          onAgentStart(callback) {
            startListener = callback;
            return () => {};
          },
          onAgentMessage(callback) {
            messageListener = callback;
            return () => {};
          },
          async ready() {
            messageListener?.({
              protocolMajor: 1,
              requestId: "delivery-1",
              messageId: "message-1",
              deliveryId: "delivery-1",
              sequence: 1,
              workspaceId: connection.workspaceId,
              conversationId: "conversation-a",
              agentId: "agent-a",
              body: "hello",
              method: "agent:v1:message:deliver",
              target: "@ada",
            });
            startListener?.({
              protocolMajor: 1,
              requestId: "start-1",
              workspaceId: connection.workspaceId,
              computerId: connection.computerId,
              agentId: "agent-a",
              provider: "pi",
              model: "default",
              reasoning: "balanced",
            });
          },
          async requestAgentLaunchConfig({ agentId }) {
            if (agentId === "agent-b") await secondCredential;
            return agentLaunchConfig(`sk_agent_${"a".repeat(43)}`);
          },
          sendAgentStatus({ agentId, status }) {
            if (agentId === "agent-b" && status === "active") secondAgentActive();
          },
          async sendAgentDeliveryAck() {},
          async stop() {},
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
    );
    const starting = runtime.start(connection);
    try {
      await notifying;
      startListener?.({
        protocolMajor: 1,
        requestId: "start-2",
        workspaceId: connection.workspaceId,
        computerId: connection.computerId,
        agentId: "agent-b",
        provider: "pi",
        model: "default",
        reasoning: "balanced",
      });
      releaseNotify();
      await starting;
      expect(events).toEqual(["start:agent-a", "notify:agent-a", "notify:agent-a"]);
      releaseSecondCredential();
      await secondActive;
      expect(events).toEqual([
        "start:agent-a",
        "notify:agent-a",
        "notify:agent-a",
        "start:agent-b",
      ]);
    } finally {
      releaseNotify();
      releaseSecondCredential();
      await starting;
      await runtime.stop();
    }
  });
  test("recreates transport after a failed start", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    let created = 0;
    let starts = 0;
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async createAgentSession() {
          return sessionSpy();
        },
      }),
      credentials,
      {
        create: () => {
          created++;
          const attempt = created;
          return {
            async start() {
              starts++;
              if (attempt === 1) throw new Error("start failed");
            },
            async ready() {},
            async stop() {},
          };
        },
      },
      undefined,
      emptyCodeAgentDiscovery,
    );
    await expect(runtime.start(connection)).rejects.toThrow("start failed");
    await runtime.start(connection);
    expect(starts).toBe(2);
    expect(created).toBe(2);
    await runtime.stop();
  });
  test("removes startup listeners and buffered publications when ready fails", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    let listener: ((intent: Parameters<DaemonRuntime["handleAgentStart"]>[0]) => void) | undefined;
    let unsubscribed = false;
    const runtime = new DaemonRuntime(
      connection,
      () => ({ provider: "pi", createAgentSession: async () => sessionSpy() }),
      credentials,
      {
        create: () => ({
          async start() {},
          onAgentStart(callback) {
            listener = callback;
            return () => {
              unsubscribed = true;
              listener = undefined;
            };
          },
          async ready() {
            listener?.({
              protocolMajor: 1,
              requestId: "discarded-publication",
              workspaceId: connection.workspaceId,
              computerId: connection.computerId,
              agentId: "agent-a",
              provider: "pi",
              model: "default",
              reasoning: "balanced",
              sessionId: "session-a",
            });
            throw new Error("ready failed");
          },
          async stop() {},
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
    );
    await expect(runtime.start(connection)).rejects.toThrow("ready failed");
    expect(unsubscribed).toBe(true);
    expect(listener).toBeUndefined();
    expect(runtime.agentProcessManager.size).toBe(0);
  });
  test("releases Agent runtimes when transport stop fails", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    let shutdownTransport = false;
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async createAgentSession() {
          return sessionSpy();
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async requestAgentLaunchConfig() {
            return agentLaunchConfig(`sk_agent_${"a".repeat(43)}`);
          },
          async stop() {
            shutdownTransport = true;
            throw new Error("stop failed");
          },
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
    );
    await runtime.start(connection);
    await runtime.startAgent("agent-a", config);
    await expect(runtime.stop()).rejects.toThrow("stop failed");
    expect(shutdownTransport).toBe(true);
    expect(runtime.agentProcessManager.size).toBe(0);
  });
  test("waits for an in-flight start before stopping the transport", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const entered = Promise.withResolvers<void>();
    let release!: () => void;
    const started = new Promise<void>((resolve) => (release = resolve));
    const calls: string[] = [];
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async createAgentSession() {
          return sessionSpy();
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {
            calls.push("start");
            entered.resolve();
            await started;
          },
          async ready() {},
          async stop() {
            calls.push("stop");
          },
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
    );
    const starting = runtime.start(connection);
    const stopping = runtime.stop();
    await entered.promise;
    expect(calls).toEqual(["start"]);
    release();
    await Promise.all([starting, stopping]);
    expect(calls).toEqual(["start", "stop"]);
  });
  test("passes the runtime provider config to its provider without interpreting it", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    let startedCredential: unknown;
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async createAgentSession(options) {
          startedCredential = options.runtime?.providerConfig;
          return sessionSpy();
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async requestAgentLaunchConfig() {
            return agentLaunchConfig(`sk_agent_${"a".repeat(43)}`, {
              kind: "coforge",
              providerId: "deepseek",
              apiKey: "sk-deepseek-secret",
            });
          },
          async revokeAgentApiKey() {},
          async stop() {},
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
    );
    await runtime.start(connection);
    await runtime.startAgent("agent-a", {
      provider: "pi",
      model: "deepseek-chat",
      modelProvider: "deepseek",
      reasoning: "high",
      providerConfig: {
        kind: "coforge",
        providerId: "deepseek",
        apiKey: "sk-deepseek-secret",
      },
    });
    expect(startedCredential).toEqual({
      kind: "coforge",
      providerId: "deepseek",
      apiKey: "sk-deepseek-secret",
    });
    await runtime.stop();
  });
  test("fails to start without a credential and can be retried", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    let starts = 0;
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async createAgentSession() {
          return sessionSpy();
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {
            starts++;
          },
          async ready() {},
          async stop() {},
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
    );
    await expect(runtime.start(connection)).rejects.toThrow("credential is missing");
    await credentials.save(connection.workspaceId, connection.computerId, "retry-token");
    await runtime.start(connection);
    expect(starts).toBe(1);
    await runtime.stop();
  });
  test("reports Message received after acceptance and before ACK, once per injection", async () => {
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const events: string[] = [];
    const activities: import("@lrm/coforge-sdk/internal").AgentActivity[] = [];
    const harness = await queueHarness({
      lifecycle: (event) => events.push(event),
      activity: (activity) => activities.push(activity),
      notify: async () => {
        entered.resolve();
        await gate.promise;
        events.push("accepted");
      },
    });
    try {
      await harness.runtime.startAgent("agent-a", config);
      events.length = 0;
      const delivery = harness.delivery(1);
      await entered.promise;
      expect(events).toEqual([]);
      gate.resolve();
      await delivery;
      expect(events).toEqual(["accepted", "activity:message_received", "ack:delivery-1"]);
      expect(activities[1]).toMatchObject({
        agentId: "agent-a",
        detailKind: "message_received",
        detail: "Message received",
        level: "info",
        entries: [],
        launchId: activities[0]!.launchId,
        clientSeq: activities[0]!.clientSeq + 1,
      });
      await harness.delivery(1);
      expect(activities).toHaveLength(2);
      expect(harness.notices).toHaveLength(1);
    } finally {
      gate.resolve();
      await harness.runtime.stop();
    }
  });
  test.each(["wake", "resume", "summary"])(
    "reports accepted %s recovery only for concrete messages",
    async (kind) => {
      const entered = Promise.withResolvers<void>();
      const gate = Promise.withResolvers<void>();
      const activities: import("@lrm/coforge-sdk/internal").AgentActivity[] = [];
      const harness = await queueHarness({
        activity: (activity) => activities.push(activity),
        notify: async () => {
          entered.resolve();
          await gate.promise;
        },
      });
      const message = {
        messageId: "recovery-message",
        deliveryId: "recovery-delivery",
        conversationId: "conversation-a",
        sequence: 1,
        target: "@ada",
        latestSenderKind: "human" as const,
        latestSenderHandle: "ada",
        latestSenderDescription: "",
        body: "hello",
      };
      try {
        const launch = harness.runtime.startAgent("agent-a", config, undefined, "recovery", {
          ...(kind === "wake" ? { wakeMessage: message } : {}),
          resumeMessages: kind === "resume" ? [message] : [],
          unreadSummary: { "@ada": 3 },
        });
        await entered.promise;
        expect(activities.map((activity) => activity.detailKind)).toEqual(["starting"]);
        gate.resolve();
        await launch;
        expect(activities.map((activity) => activity.detailKind)).toEqual(
          kind === "summary" ? ["starting"] : ["starting", "message_received"],
        );
        if (kind !== "summary") {
          expect(activities[1]).toMatchObject({
            agentId: "agent-a",
            detailKind: "message_received",
            detail: "Message received",
            level: "info",
            entries: [],
            launchId: activities[0]!.launchId,
            clientSeq: activities[0]!.clientSeq + 1,
          });
          await harness.runtime.startAgent("agent-a", config, undefined, "duplicate-wake", {
            wakeMessage: message,
          });
          expect(activities).toHaveLength(2);
          expect(harness.notices).toHaveLength(1);
        }
      } finally {
        gate.resolve();
        await harness.runtime.stop();
      }
    },
  );
  test("late acceptance while stopping does not report Message received", async () => {
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const activities: string[] = [];
    const harness = await queueHarness({
      activity: (activity) => activities.push(activity.detailKind),
      notify: async () => {
        entered.resolve();
        await gate.promise;
      },
    });
    try {
      await harness.runtime.startAgent("agent-a", config);
      const delivery = harness.delivery(1);
      void delivery.catch(() => {});
      await entered.promise;
      const stopping = harness.runtime.stopAgent("agent-a");
      gate.resolve();
      await expect(delivery).rejects.toThrow("cancelled");
      await stopping;
      await harness.runtime.startAgent("agent-a", config);
      expect(activities).toEqual(["starting", "stopped", "starting"]);
      expect(harness.acknowledgements).toEqual([]);
    } finally {
      gate.resolve();
      await harness.runtime.stop();
    }
  });
  test("Activity publication failure does not reject accepted delivery", async () => {
    const harness = await queueHarness({
      activity: (activity) => {
        if (activity.detailKind === "message_received") throw new Error("offline observer");
      },
    });
    try {
      await harness.runtime.startAgent("agent-a", config);
      await harness.delivery(1);
      await harness.delivery(1);
      expect(harness.acknowledgements).toEqual(["delivery-1", "delivery-1"]);
      expect(harness.notices).toHaveLength(1);
    } finally {
      await harness.runtime.stop();
    }
  });
  test("does not ACK rejected notification and accepts redelivery in the same session", async () => {
    let attempts = 0;
    const activities: string[] = [];
    const harness = await queueHarness({
      activity: (activity) => activities.push(activity.detailKind),
      notify: () => {
        attempts++;
        if (attempts === 1) throw new Error("code agent request failed");
      },
    });
    try {
      await harness.runtime.startAgent("agent-a", config);
      await expect(harness.delivery(1)).rejects.toThrow("code agent request failed");
      expect(harness.acknowledgements).toEqual([]);
      expect(activities).toEqual(["starting"]);
      await harness.delivery(1);
      expect(attempts).toBe(2);
      expect(activities).toEqual(["starting", "message_received"]);
      expect(harness.acknowledgements).toEqual(["delivery-1"]);
      expect(harness.sessions()).toBe(1);
    } finally {
      await harness.runtime.stop();
    }
  });
  test("shares a concurrent Agent launch and mints one credential", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    let release!: (credential: string) => void;
    const credential = new Promise<string>((resolve) => (release = resolve));
    let mints = 0;
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async createAgentSession() {
          return sessionSpy();
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async stop() {},
          async requestAgentLaunchConfig() {
            mints++;
            return agentLaunchConfig(await credential);
          },
          async revokeAgentApiKey() {},
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
    );
    await runtime.start(connection);
    const first = runtime.startAgent("agent-a", config);
    const second = runtime.startAgent("agent-a", config);
    expect(second).toBe(first);
    expect(mints).toBe(1);
    release(`sk_agent_${"a".repeat(43)}`);
    await Promise.all([first, second]);
    await runtime.stop();
  });
  const fresh = expect.stringContaining("fresh session.");
  test("a create launch gets recovery without inbox input", async () => {
    const harness = await queueHarness();
    await harness.runtime.startAgent(
      "agent-a",
      config,
      "cloud-first",
      "create-request",
      undefined,
      undefined,
      "create",
    );
    expect(harness.notices).toEqual([]);
    expect(harness.startupNotices).toEqual([fresh]);
    await harness.runtime.stop();
  });
  const resumePrompt = "Stop editing the schema; only the frontend.";
  const resumeIntent = {
    protocolMajor: 1,
    requestId: "resume-prompt-request",
    workspaceId: connection.workspaceId,
    computerId: connection.computerId,
    agentId: "agent-a",
    provider: "pi" as const,
    model: "",
    reasoning: "",
    resumePrompt,
  };
  function firstNotice() {
    let resolve!: (notice: string) => void;
    const notice = new Promise<string>((done) => (resolve = done));
    return { notice, notify: (text: string) => resolve(text) };
  }
  test("a resume prompt opens a resumed session's first turn", async () => {
    const first = firstNotice();
    const harness = await queueHarness({ notify: first.notify });
    await harness.runtime.handleAgentStart({
      ...resumeIntent,
      sessionId: "stored-session-id",
      sessionMode: "resume",
      controlEpoch: 1,
      launchId: "launch-resume-1",
    });
    expect(await first.notice).toBe(resumePrompt);
    expect(harness.notices).toEqual([resumePrompt]);
    await harness.runtime.stop();
  });
  test("a resume prompt opens a new session's first turn", async () => {
    const first = firstNotice();
    const harness = await queueHarness({ notify: first.notify });
    await harness.runtime.handleAgentStart({ ...resumeIntent, sessionMode: "create" });
    expect(await first.notice).toContain(resumePrompt);
    expect(harness.notices).toHaveLength(1);
    expect(harness.notices[0]).toContain("<memory-index");
    expect(harness.notices[0]).toContain(resumePrompt);
    await harness.runtime.stop();
  });
  test("a resume prompt reaches an Agent that is already running", async () => {
    const first = firstNotice();
    const harness = await queueHarness({ notify: first.notify });
    await harness.runtime.startAgent("agent-a", config);
    await harness.runtime.handleAgentStart(resumeIntent);
    expect(await first.notice).toBe(resumePrompt);
    await harness.runtime.stop();
  });
  const introductionPrompt = "Introduce yourself to Ada in your direct conversation.";
  const introductionIntent = {
    ...resumeIntent,
    requestId: "introduction-request",
    resumePrompt: undefined,
    introductionPrompt,
  };
  test("an introduction replaces fresh-session recovery", async () => {
    const harness = await queueHarness();
    try {
      await harness.runtime.handleAgentStart({
        ...introductionIntent,
        sessionMode: "create",
        controlEpoch: 1,
        launchId: "launch-introduction-1",
      });
      await harness.delivery(1);
      expect(harness.notices[0]).toContain(introductionPrompt);
      expect(harness.notices).toHaveLength(2);
      expect(harness.startupNotices).toEqual([]);
    } finally {
      await harness.runtime.stop();
    }
  });
  test("an introduction runs before the launch's message recovery, which still runs", async () => {
    const harness = await queueHarness();
    try {
      await harness.runtime.handleAgentStart({
        ...introductionIntent,
        unreadSummary: { "#team": 3 },
      });
      expect(harness.notices).toHaveLength(2);
      expect(harness.notices[0]).toContain(introductionPrompt);
      expect(harness.notices[1]).toContain("#team 3 new messages");
      expect(harness.startupNotices).toEqual([]);
    } finally {
      await harness.runtime.stop();
    }
  });
  test("a running process is handed one introduction however many Starts carry it", async () => {
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const harness = await queueHarness({
      notify: async () => {
        entered.resolve();
        await gate.promise;
      },
    });
    try {
      await harness.runtime.startAgent("agent-a", config);
      const first = harness.runtime.handleAgentStart(introductionIntent);
      await entered.promise;
      await harness.runtime.handleAgentStart({ ...introductionIntent, requestId: "second-start" });
      gate.resolve();
      await first;
      await harness.runtime.handleAgentStart({ ...introductionIntent, requestId: "third-start" });
      expect(harness.notices).toHaveLength(1);
      expect(harness.notices[0]).toContain(introductionPrompt);
    } finally {
      gate.resolve();
      await harness.runtime.stop();
    }
  });
  test("a joining Start replaces fresh recovery with its introduction", async () => {
    const gate = Promise.withResolvers<void>();
    const harness = await queueHarness({ launch: () => gate.promise });
    try {
      const waking = harness.runtime.startAgent("agent-a", config);
      const joining = harness.runtime.handleAgentStart(introductionIntent);
      gate.resolve();
      await Promise.all([waking, joining]);
      expect(harness.notices).toHaveLength(1);
      expect(harness.notices[0]).toContain(introductionPrompt);
      expect(harness.startupNotices).toEqual([]);
      expect(harness.sessions()).toBe(1);
    } finally {
      gate.resolve();
      await harness.runtime.stop();
    }
  });
  test("a managed Start that rebinds a running process hands it the introduction", async () => {
    const first = firstNotice();
    const harness = await queueHarness({ notify: first.notify });
    try {
      const managed = { ...introductionIntent, introductionPrompt: undefined, controlEpoch: 1 };
      await harness.runtime.handleAgentStart({ ...managed, launchId: "launch-rebind-1" });
      await harness.runtime.handleAgentStart({
        ...managed,
        requestId: "rebind-introduction",
        controlEpoch: 2,
        launchId: "launch-rebind-2",
        introductionPrompt,
      });
      expect(await first.notice).toContain(introductionPrompt);
      expect(harness.sessions()).toBe(1);
    } finally {
      await harness.runtime.stop();
    }
  });
  test("a launch after the process exited or stopped introduces again", async () => {
    const harness = await queueHarness();
    try {
      await harness.runtime.handleAgentStart(introductionIntent);
      await harness.delivery(1);
      harness.exit();
      await harness.runtime.handleAgentStart(introductionIntent);
      await harness.delivery(2);
      await harness.runtime.stopAgent("agent-a");
      await harness.runtime.handleAgentStart(introductionIntent);
      await harness.delivery(3);
      expect(harness.sessions()).toBe(3);
      expect(harness.notices.filter((notice) => notice.includes(introductionPrompt))).toHaveLength(
        3,
      );
      expect(harness.startupNotices).toEqual([]);
    } finally {
      await harness.runtime.stop();
    }
  });
  test("an introduction still queued when the process exits is the next launch's only one", async () => {
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const relaunched = Promise.withResolvers<void>();
    let notifications = 0;
    let activations = 0;
    const harness = await queueHarness({
      notify: async () => {
        if (++notifications > 1) return;
        entered.resolve();
        await gate.promise;
      },
      lifecycle: (event) => {
        if (event === "status:active" && ++activations === 2) relaunched.resolve();
      },
    });
    try {
      await harness.runtime.startAgent("agent-a", config);
      const delivery = harness.delivery(1);
      void delivery.catch(() => {});
      await entered.promise;
      const introducing = harness.runtime.handleAgentStart(introductionIntent);
      void introducing.catch(() => {});
      harness.exit();
      const relaunch = harness.runtime.handleAgentStart(introductionIntent);
      await relaunched.promise;
      gate.resolve();
      await relaunch;
      await harness.delivery(2);
      await harness.runtime.handleAgentStart({ ...introductionIntent, requestId: "later-start" });
      await harness.delivery(3);
      expect(harness.sessions()).toBe(2);
      expect(harness.notices.filter((notice) => notice.includes(introductionPrompt))).toHaveLength(
        1,
      );
      expect(harness.startupNotices).toEqual([fresh]);
    } finally {
      gate.resolve();
      await harness.runtime.stop();
    }
  });
  test("a resume launch opens one recovery startup turn", async () => {
    const harness = await queueHarness();
    await harness.runtime.startAgent(
      "agent-a",
      config,
      "stored-session-id",
      "resume-request",
      undefined,
      undefined,
      "resume",
    );
    expect(harness.notices).toEqual([]);
    expect(harness.startupNotices).toEqual([
      expect.stringContaining("Use your existing session context first."),
    ]);
    await harness.runtime.stop();
  });
  test("a fresh launch opens one startup turn", async () => {
    const harness = await queueHarness();
    await harness.runtime.startAgent("agent-a", config);
    expect(harness.startupNotices).toEqual([fresh]);
    await harness.runtime.stop();
  });
  test("summary-only startup catch-up reads each target once and acts only on directed work", async () => {
    const harness = await queueHarness();
    try {
      await harness.runtime.startAgent("agent-a", config, "stored-session", "resume-summary", {
        unreadSummary: { "#team": 3 },
      });
      expect(harness.startupNotices).toEqual([]);
      expect(harness.notices).toHaveLength(1);
      expect(harness.notices[0]).toContain("coforge message read --target <target>");
      expect(harness.notices[0]).toContain("once");
      expect(harness.notices[0]).toContain("direct request");
      expect(harness.notices[0]).toContain("Do not call `coforge message check`");
    } finally {
      await harness.runtime.stop();
    }
  });
  test("a create launch with a wake message sends only the wake notice", async () => {
    const harness = await queueHarness();
    await harness.runtime.startAgent(
      "agent-a",
      config,
      undefined,
      "wake-request",
      {
        wakeMessage: {
          messageId: "wake-message",
          deliveryId: "wake-delivery",
          conversationId: "conversation-a",
          sequence: 1,
          target: "@ada",
          latestSenderKind: "human" as const,
          latestSenderHandle: "ada",
          latestSenderDescription: "",
          body: "wake only",
        },
      },
      undefined,
      "create",
    );
    await Bun.sleep(10);
    expect(harness.notices).toHaveLength(1);
    expect(harness.notices[0]).toContain("[CoForge inbox notice:");
    expect(harness.notices[0]).toContain("@ada 1 new message");
    expect(harness.notices[0]).not.toContain("wake only");
    await harness.runtime.stop();
  });
  test("a stop that races a create launch sends no notices", async () => {
    let releaseLaunch!: () => void;
    const launchGate = new Promise<void>((resolve) => (releaseLaunch = resolve));
    const harness = await queueHarness({ launch: () => launchGate });
    const launching = harness.runtime.startAgent(
      "agent-a",
      config,
      undefined,
      "create-request",
      undefined,
      undefined,
      "create",
    );
    await Bun.sleep(0);
    const stopping = harness.runtime.stopAgent("agent-a");
    releaseLaunch();
    await expect(launching).rejects.toThrow("stopping");
    await stopping;
    await Bun.sleep(10);
    expect(harness.notices).toEqual([]);
    await harness.runtime.stop();
  });
  test("queues launch recovery before live delivery", async () => {
    let release!: (credential: string) => void;
    const credential = new Promise<string>((resolve) => (release = resolve));
    const harness = await queueHarness({ credential });
    const launch = harness.runtime.startAgent("agent-a", config);
    const launchRecovery = {
      resumeMessages: [
        {
          messageId: "message-recovery",
          deliveryId: "delivery-recovery",
          conversationId: "conversation-a",
          sequence: 1,
          target: "@ada",
          latestSenderKind: "human" as const,
          latestSenderHandle: "ada",
          latestSenderDescription: "",
          body: "hello from recovery",
        },
      ],
      unreadSummary: { "@ada": 1 },
    };
    const recoveryForLaunch = harness.runtime.startAgent(
      "agent-a",
      config,
      undefined,
      "recovery",
      launchRecovery,
    );
    const live = harness.delivery(2);
    release(`sk_agent_${"a".repeat(43)}`);
    const [started, recovered] = await Promise.all([launch, recoveryForLaunch, live]);
    expect(recovered).toBe(started);
    expect(harness.notices[0]).toContain("@ada 1 new message");
    expect(harness.notices[0]).not.toContain("hello from recovery");
    expect(harness.notices[1]).toContain("CoForge inbox notice");
    expect(harness.acknowledgements).toEqual(["delivery-2"]);
    expect(harness.sessions()).toBe(1);
    await harness.runtime.stop();
  });
  test("ready waits for recovery added to an existing launch", async () => {
    let releaseLaunch!: () => void;
    let releaseRecovery!: () => void;
    const launchGate = new Promise<void>((resolve) => (releaseLaunch = resolve));
    const recoveryGate = new Promise<void>((resolve) => (releaseRecovery = resolve));
    const harness = await queueHarness({ launch: () => launchGate, notify: () => recoveryGate });
    const launching = harness.runtime.startAgent("agent-a", config);
    const recovering = harness.runtime.startAgent(
      "agent-a",
      config,
      undefined,
      "recovery",
      recovery,
    );
    releaseLaunch();
    const started = await launching;
    expect(harness.runningAgentIds()).toEqual([]);
    releaseRecovery();
    const recovered = await recovering;
    expect(recovered).toBe(started);
    expect(harness.sessions()).toBe(1);
    expect(harness.runningAgentIds()).toEqual(["agent-a"]);
    await harness.runtime.stop();
  });
  test("ready reports only Agents past recovery and outside stopping", async () => {
    let releaseRecovery!: () => void;
    let releaseDispose!: () => void;
    const recoveryGate = new Promise<void>((resolve) => (releaseRecovery = resolve));
    const disposeGate = new Promise<void>((resolve) => (releaseDispose = resolve));
    const harness = await queueHarness({ notify: () => recoveryGate, dispose: () => disposeGate });
    const launching = harness.runtime.startAgent("agent-a", config, undefined, "recovery", {
      resumeMessages: [
        {
          messageId: "message-recovery",
          deliveryId: "delivery-recovery",
          conversationId: "conversation-a",
          sequence: 1,
          target: "@ada",
          latestSenderKind: "human" as const,
          latestSenderHandle: "ada",
          latestSenderDescription: "",
          body: "recover",
        },
      ],
      unreadSummary: { "@ada": 1 },
    });
    await Bun.sleep(0);
    expect(harness.runningAgentIds()).toEqual([]);
    releaseRecovery();
    await launching;
    expect(harness.runningAgentIds()).toEqual(["agent-a"]);
    const stopping = harness.runtime.stopAgent("agent-a");
    expect(harness.runningAgentIds()).toEqual([]);
    releaseDispose();
    await stopping;
    await harness.runtime.stop();
  });
  test("failed launch recovery disposes the runtime and can retry canonical recovery", async () => {
    let notifyAttempts = 0;
    let disposals = 0;
    const received: string[] = [];
    const harness = await queueHarness({
      activity(activity) {
        if (activity.detailKind === "message_received") received.push(activity.detail);
      },
      notify() {
        notifyAttempts++;
        if (notifyAttempts === 1) throw new Error("recovery rejected");
      },
      dispose() {
        disposals++;
      },
    });
    const recoveryContext = {
      resumeMessages: [
        {
          messageId: "message-recovery",
          deliveryId: "delivery-recovery",
          conversationId: "conversation-a",
          sequence: 1,
          target: "@ada",
          latestSenderKind: "human" as const,
          latestSenderHandle: "ada",
          latestSenderDescription: "",
          body: "retry this recovery body",
        },
      ],
      unreadSummary: { "@ada": 1 },
    };
    await expect(
      harness.runtime.startAgent("agent-a", config, undefined, "failed-recovery", recoveryContext),
    ).rejects.toThrow("recovery rejected");
    expect(harness.runningAgentIds()).toEqual([]);
    expect(disposals).toBe(1);
    expect(received).toEqual([]);
    await harness.runtime.startAgent(
      "agent-a",
      config,
      undefined,
      "retried-recovery",
      recoveryContext,
    );
    expect(harness.sessions()).toBe(2);
    expect(harness.notices).toHaveLength(1);
    expect(harness.notices.every((notice) => notice.startsWith("[CoForge inbox notice:"))).toBe(
      true,
    );
    expect(harness.notices.every((notice) => !notice.includes("retry this recovery body"))).toBe(
      true,
    );
    expect(received).toEqual(["Message received"]);
    expect(harness.runningAgentIds()).toEqual(["agent-a"]);
    await harness.runtime.stop();
  });
  test("failed launch recovery preserves an explicit stop fence until stop completes", async () => {
    let rejectRecovery!: (error: Error) => void;
    let markRecoveryStarted!: () => void;
    let markDisposed!: () => void;
    const recoveryGate = new Promise<void>((_, reject) => (rejectRecovery = reject));
    const recoveryStarted = new Promise<void>((resolve) => (markRecoveryStarted = resolve));
    const disposed = new Promise<void>((resolve) => (markDisposed = resolve));
    const harness = await queueHarness({
      async notify(notice) {
        if (notice.includes("not a request")) return;
        markRecoveryStarted();
        await recoveryGate;
      },
      dispose() {
        markDisposed();
      },
    });
    const launching = harness.runtime.startAgent(
      "agent-a",
      config,
      undefined,
      "blocked-recovery",
      recovery,
    );
    await recoveryStarted;
    const startDuringStop = launching.then(
      () => "launch unexpectedly succeeded",
      async () => {
        try {
          await harness.runtime.startAgent("agent-a", config);
          return "start unexpectedly succeeded";
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
    );
    const stopping = harness.runtime.stopAgent("agent-a");
    rejectRecovery(new Error("recovery rejected"));
    await expect(launching).rejects.toThrow("stopping");
    await disposed;
    expect(await startDuringStop).toContain("stopping");
    await stopping;
    await harness.runtime.startAgent("agent-a", config);
    await harness.runtime.stop();
  });
  test("active recovery rebind keeps its runtime and precedes live delivery", async () => {
    let releaseRecovery!: () => void;
    const recoveryGate = new Promise<void>((resolve) => (releaseRecovery = resolve));
    const harness = await queueHarness({
      notify: (notice) => (notice.includes("wake only") ? recoveryGate : undefined),
    });
    const active = await harness.runtime.startAgent("agent-a", config);
    const rebound = harness.runtime.startAgent("agent-a", config, undefined, "recovery", {
      wakeMessage: {
        messageId: "wake-message",
        deliveryId: "wake-delivery",
        conversationId: "conversation-a",
        sequence: 3,
        target: "@ada",
        latestSenderKind: "human" as const,
        latestSenderHandle: "ada",
        latestSenderDescription: "",
        body: "wake only",
      },
      resumeMessages: [
        {
          messageId: "resume-message",
          deliveryId: "resume-delivery",
          conversationId: "conversation-a",
          sequence: 2,
          target: "@ada",
          latestSenderKind: "human" as const,
          latestSenderHandle: "ada",
          latestSenderDescription: "",
          body: "must be ignored",
        },
      ],
      unreadSummary: { "@grace": 9 },
    });
    const live = harness.delivery(4);
    await Bun.sleep(0);
    expect(harness.notices).toHaveLength(2);
    expect(harness.notices[0]).toContain("[CoForge inbox notice:");
    expect(harness.notices[0]).toContain("@ada 1 new message");
    expect(harness.notices[0]).not.toContain("wake only");
    expect(harness.notices[0]).not.toContain("must be ignored");
    expect(harness.notices[0]).not.toContain("@grace");
    expect(harness.notices[1]).toContain("CoForge inbox notice");
    expect(harness.acknowledgements).toEqual(["delivery-4"]);
    releaseRecovery();
    expect(await rebound).toBe(active);
    await live;
    expect(harness.acknowledgements).toEqual(["delivery-4"]);
    expect(harness.sessions()).toBe(1);
    expect(harness.mints()).toBe(1);
    await harness.runtime.stop();
  });
  test("active rebind without a wake ignores resume context and continues live delivery", async () => {
    const harness = await queueHarness();
    await harness.runtime.startAgent("agent-a", config);
    await Promise.all([
      harness.runtime.startAgent("agent-a", config, undefined, "recovery", recovery),
      harness.delivery(2),
    ]);
    expect(harness.notices).toHaveLength(1);
    expect(harness.notices[0]).toContain("CoForge inbox notice");
    expect(harness.acknowledgements).toEqual(["delivery-2"]);
    await harness.runtime.stop();
  });
  test.each(["agent", "daemon"])(
    "%s stop waits for creation even after queued recovery is cancelled",
    async (ending) => {
      const creating = Promise.withResolvers<void>();
      const created = Promise.withResolvers<void>();
      const harness = await queueHarness({
        launch() {
          creating.resolve();
          return created.promise;
        },
      });
      const launching = harness.runtime.startAgent("agent-a", config);
      void launching.catch(() => {});
      await creating.promise;
      const extended = harness.runtime.startAgent(
        "agent-a",
        config,
        undefined,
        "extra-recovery",
        recovery,
      );
      void extended.catch(() => {});
      let stopped = false;
      const stopping = (
        ending === "agent" ? harness.runtime.stopAgent("agent-a") : harness.runtime.stop()
      ).then(() => {
        stopped = true;
      });
      try {
        await Bun.sleep(0);
        expect(stopped).toBe(false);
        created.resolve();
        await stopping;
        expect(harness.runtime.agentProcessManager.size).toBe(0);
        await expect(launching).rejects.toThrow("stopping");
        await expect(extended).rejects.toThrow();
      } finally {
        created.resolve();
        await Promise.allSettled([launching, extended, stopping]);
        await harness.runtime.stop();
      }
    },
  );
  test("stop completes when a session whose creation was still pending cannot be cleaned up", async () => {
    const creating = Promise.withResolvers<void>();
    const created = Promise.withResolvers<void>();
    const activities: string[] = [];
    const harness = await queueHarness({
      launch() {
        creating.resolve();
        return created.promise;
      },
      dispose() {
        throw new AgentProcessCleanupError();
      },
      activity(activity) {
        activities.push(activity.detailKind);
      },
    });
    const launching = harness.runtime.startAgent("agent-a", config);
    void launching.catch(() => {});
    await creating.promise;
    const stopping = harness.runtime.stopAgent("agent-a");
    created.resolve();
    try {
      await expect(stopping).resolves.toBeUndefined();
      await expect(launching).rejects.toThrow();
      expect(activities).not.toContain("runtime_error");
      expect(harness.runtime.agentProcessManager.size).toBe(0);
    } finally {
      await harness.runtime.stop().catch(() => {});
    }
  });
  test("daemon shutdown disposes a session before awaiting its launch recovery notice", async () => {
    const entered = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<void>();
    const harness = await queueHarness({
      notify() {
        entered.resolve();
        return pending.promise;
      },
      dispose() {
        pending.reject(new Error("disposed"));
      },
    });
    const launching = harness.runtime.startAgent(
      "agent-a",
      config,
      undefined,
      "recovery",
      recovery,
    );
    void launching.catch(() => {});
    await entered.promise;
    const stopping = harness.runtime.stop();
    try {
      expect(
        await Promise.race([stopping.then(() => "stopped"), Bun.sleep(100).then(() => "blocked")]),
      ).toBe("stopped");
      await expect(launching).rejects.toThrow();
      expect(harness.acknowledgements).toEqual([]);
    } finally {
      pending.reject(new Error("test cleanup"));
      await Promise.allSettled([launching, stopping]);
    }
  });
  test("stop disposes a session before waiting for its queued notice to settle", async () => {
    const entered = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<void>();
    const harness = await queueHarness({
      notify() {
        entered.resolve();
        return pending.promise;
      },
      dispose() {
        pending.reject(new Error("notice cancelled by disposal"));
      },
    });
    await harness.runtime.startAgent("agent-a", config);
    const delivery = harness.delivery(1);
    void delivery.catch(() => {});
    await entered.promise;
    const stopping = harness.runtime.stopAgent("agent-a");
    try {
      expect(
        await Promise.race([stopping.then(() => "stopped"), Bun.sleep(100).then(() => "blocked")]),
      ).toBe("stopped");
      await expect(delivery).rejects.toThrow("cancelled");
      expect(harness.acknowledgements).toEqual([]);
      await harness.runtime.startAgent("agent-a", config);
      expect(harness.sessions()).toBe(2);
    } finally {
      pending.reject(new Error("test cleanup"));
      await Promise.allSettled([delivery, stopping]);
      await harness.runtime.stop();
    }
  });
  test("stop cancels a notice even if the provider reports acceptance only after replacement", async () => {
    const entered = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<void>();
    const harness = await queueHarness({
      notify() {
        entered.resolve();
        return pending.promise;
      },
    });
    await harness.runtime.startAgent("agent-a", config);
    const delivery = harness.delivery(1);
    void delivery.catch(() => {});
    await entered.promise;
    const stopping = harness.runtime.stopAgent("agent-a");
    try {
      expect(
        await Promise.race([stopping.then(() => "stopped"), Bun.sleep(100).then(() => "blocked")]),
      ).toBe("stopped");
      await expect(delivery).rejects.toThrow("cancelled");
      await harness.runtime.startAgent("agent-a", config);
      pending.resolve();
      await Bun.sleep(0);
      expect(harness.acknowledgements).toEqual([]);
      expect(harness.runningAgentIds()).toEqual(["agent-a"]);
    } finally {
      pending.resolve();
      await Promise.allSettled([delivery, stopping]);
      await harness.runtime.stop();
    }
  });
  test("stop cancels current and queued input without acknowledging either", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const harness = await queueHarness({ notify: () => gate });
    await harness.runtime.startAgent("agent-a", config);
    const current = harness.delivery(1);
    void current.catch(() => {});
    const queued = harness.delivery(2);
    void queued.catch(() => {});
    await Bun.sleep(0);
    const stop = harness.runtime.stopAgent("agent-a");
    release();
    await expect(current).rejects.toThrow("cancelled");
    await stop;
    await expect(queued).rejects.toThrow("stopping");
    expect(harness.notices).toHaveLength(1);
    expect(harness.acknowledgements).toEqual([]);
    await harness.runtime.stop();
  });
  test("stopAgent during credential mint cancels that launch and permits a later launch", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    let release!: (credential: string) => void;
    const pendingCredential = new Promise<string>((resolve) => (release = resolve));
    const replacementCredential = `sk_agent_${"c".repeat(43)}`;
    let mintCount = 0;
    let childStarts = 0;
    const revoked: string[] = [];
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async createAgentSession() {
          childStarts++;
          return sessionSpy();
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async stop() {},
          async requestAgentLaunchConfig() {
            mintCount++;
            return agentLaunchConfig(
              mintCount === 1 ? await pendingCredential : replacementCredential,
            );
          },
          async revokeAgentApiKey(value) {
            revoked.push(value);
          },
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
    );
    await runtime.start(connection);
    const launching = runtime.startAgent("agent-a", config);
    const stopping = runtime.stopAgent("agent-a");
    await expect(runtime.startAgent("agent-a", config)).rejects.toThrow("stopping");
    const cancelledCredential = `sk_agent_${"b".repeat(43)}`;
    release(cancelledCredential);
    await expect(launching).rejects.toThrow("stopping");
    await stopping;
    expect(childStarts).toBe(0);
    expect(revoked).toEqual([cancelledCredential]);
    await runtime.startAgent("agent-a", config);
    expect(childStarts).toBe(1);
    await runtime.stop();
  });
  test("an old process exit cannot revoke a replacement launch's local proxy token", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    let releaseOldDispose!: () => void;
    const oldDispose = new Promise<void>((resolve) => (releaseOldDispose = resolve));
    const exitCallbacks: Array<Array<() => void>> = [];
    const proxyTokens: string[] = [];
    let launchCount = 0;
    const proxyFacade: AgentProxy = {
      url: "",
      issue: () => {
        throw new Error("proxy is not initialized");
      },
      revoke: () => undefined,
      close: () => undefined,
    };
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async createAgentSession(input) {
          launchCount++;
          proxyTokens.push(input.environment?.COFORGE_AGENT_CONTEXT ?? "");
          const currentLaunch = launchCount;
          const launchExitCallbacks: Array<() => void> = [];
          exitCallbacks.push(launchExitCallbacks);
          return {
            ...sessionSpy(),
            onExit(callback) {
              launchExitCallbacks.push(callback);
              return () => undefined;
            },
            async dispose() {
              if (currentLaunch === 1) await oldDispose;
            },
          };
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async stop() {},
          async agentMessage() {
            return {
              protocolMajor: 1,
              idempotencyKey: "replacement",
              accepted: true,
              attentionCount: 0,
              messages: [],
            };
          },
          async requestAgentLaunchConfig() {
            return agentLaunchConfig(
              `sk_agent_${String.fromCharCode(96 + launchCount + 1).repeat(43)}`,
            );
          },
          async revokeAgentApiKey() {
            throw new Error("remote revoke failed");
          },
        }),
      },
      proxyFacade,
      emptyCodeAgentDiscovery,
    );
    const proxy = startAgentProxy({ runtime });
    proxyFacade.url = proxy.url;
    proxyFacade.issue = proxy.issue;
    proxyFacade.revoke = proxy.revoke;
    proxyFacade.close = proxy.close;
    try {
      await runtime.start(connection);
      await runtime.startAgent("agent-a", config);
      const stopping = runtime.stopAgent("agent-a");
      await Promise.resolve();
      await expect(runtime.startAgent("agent-a", config)).rejects.toThrow("stopping");
      releaseOldDispose();
      await expect(stopping).resolves.toBeUndefined();
      await runtime.startAgent("agent-a", config);
      const replacementToken = proxyTokens[1]!;
      const request = () =>
        fetch(proxy.url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${replacementToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ idempotencyKey: "replacement", operation: "check" }),
        });
      expect((await request()).status).toBe(200);
      for (const callback of exitCallbacks[0] ?? []) callback();
      expect((await request()).status).toBe(200);
    } finally {
      proxy.close();
    }
  });
  test("exports the server-authored launch identity as environment variables, alongside the existing local capabilities", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    let capturedEnvironment: Readonly<Record<string, string>> | undefined;
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async createAgentSession(input) {
          capturedEnvironment = input.environment;
          return sessionSpy();
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async stop() {},
          async ready() {},
          async requestAgentLaunchConfig() {
            return {
              agentApiKey: `sk_agent_${"a".repeat(43)}`,
              identity: {
                name: "scout",
                runtimeContext: {
                  workspaceId: "ws-1",
                  workspaceSlug: "acme",
                  workspaceName: "Acme",
                  computerId: "computer-1",
                  computerName: "Builder Box",
                  computerOs: "macOS 27",
                  computerVersion: "0.1.0-dev.36",
                },
              },
            };
          },
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
    );
    try {
      await runtime.start(connection);
      await runtime.startAgent("agent-a", config);
      expect(capturedEnvironment?.COFORGE_AGENT_CONTEXT).toBeTruthy();
      expect(capturedEnvironment).toMatchObject({
        COFORGE_CURRENT_AGENT_ID: "agent-a",
        COFORGE_CURRENT_AGENT_NAME: "scout",
        COFORGE_CURRENT_WORKSPACE_ID: "ws-1",
        COFORGE_CURRENT_WORKSPACE_SLUG: "acme",
        COFORGE_CURRENT_WORKSPACE_NAME: "Acme",
        COFORGE_CURRENT_COMPUTER_ID: "computer-1",
        COFORGE_CURRENT_COMPUTER_NAME: "Builder Box",
        COFORGE_CURRENT_COMPUTER_OS: "macOS 27",
        COFORGE_CURRENT_COMPUTER_VERSION: "0.1.0-dev.36",
      });
      expect(capturedEnvironment?.COFORGE_CURRENT_AGENT_WORKSPACE_PATH).toContain("agent-a");
    } finally {
      await runtime.stop();
    }
  });
  test("converts a provider error event into a classified runtime_error activity, and a reconnecting event into runtime_reconnecting", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const activities: import("@lrm/coforge-sdk/internal").AgentActivity[] = [];
    let listener: Parameters<AgentSession["subscribe"]>[0] = () => undefined;
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async createAgentSession() {
          return {
            ...sessionSpy(),
            subscribe(next) {
              listener = next;
              return () => undefined;
            },
          };
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async stop() {},
          sendAgentActivity(activity) {
            activities.push(activity);
          },
          async requestAgentLaunchConfig() {
            return agentLaunchConfig(`sk_agent_${"a".repeat(43)}`);
          },
          async revokeAgentApiKey() {},
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
    );
    await runtime.start(connection);
    await runtime.startAgent("agent-a", config);
    listener({ type: "error", message: "provider request failed" });
    listener({ type: "reconnecting", attempt: 2, message: "Reconnecting... 2/5" });
    expect(activities.map(({ detailKind }) => detailKind)).toEqual([
      "starting",
      "runtime_error",
      "runtime_reconnecting",
    ]);
    expect(activities[1]).toMatchObject({
      level: "error",
      detail: "provider request failed",
      entries: [{ kind: "text", text: "Error: provider request failed" }],
      runtimeError: { errorClass: "AgentRuntimeError", errorReason: "runtime_failure" },
    });
    expect(activities[2]).toMatchObject({
      level: "info",
      detail: "Reconnecting... 2/5",
      entries: [{ kind: "text", text: "Reconnecting... 2/5" }],
    });
    await runtime.stop();
  });
  test("a failed turn that already reported its own runtime_error keeps that as the one visible reason", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const activities: import("@lrm/coforge-sdk/internal").AgentActivity[] = [];
    let listener: Parameters<AgentSession["subscribe"]>[0] = () => undefined;
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async createAgentSession() {
          return {
            ...sessionSpy(),
            subscribe(next) {
              listener = next;
              return () => undefined;
            },
          };
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async stop() {},
          sendAgentActivity(activity) {
            activities.push(activity);
          },
          async requestAgentLaunchConfig() {
            return agentLaunchConfig(`sk_agent_${"a".repeat(43)}`);
          },
          async revokeAgentApiKey() {},
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
    );
    await runtime.start(connection);
    await runtime.startAgent("agent-a", config);
    listener({ type: "error", message: "turn failed: provider unavailable" });
    listener({ type: "completed", status: "failed" });
    expect(activities.map(({ detailKind }) => detailKind)).toEqual(["starting", "runtime_error"]);
    expect(activities.filter((activity) => activity.level === "error")).toHaveLength(1);
    expect(activities[1]).toMatchObject({ detail: "turn failed: provider unavailable" });
    await runtime.stop();
  });
  test("a failed turn with no error event still reports the generic failure Activity", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const activities: import("@lrm/coforge-sdk/internal").AgentActivity[] = [];
    let listener: Parameters<AgentSession["subscribe"]>[0] = () => undefined;
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async createAgentSession() {
          return {
            ...sessionSpy(),
            subscribe(next) {
              listener = next;
              return () => undefined;
            },
          };
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async stop() {},
          sendAgentActivity(activity) {
            activities.push(activity);
          },
          async requestAgentLaunchConfig() {
            return agentLaunchConfig(`sk_agent_${"a".repeat(43)}`);
          },
          async revokeAgentApiKey() {},
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
    );
    await runtime.start(connection);
    await runtime.startAgent("agent-a", config);
    listener({ type: "completed", status: "failed" });
    expect(activities.map(({ detailKind }) => detailKind)).toEqual(["starting", "runtime_error"]);
    expect(activities[1]).toMatchObject({ detail: "Agent runtime failed." });
    await runtime.stop();
  });
  test("reports runtime_crashed with Crashed(...) wording on an unintentional exit that follows an unresolved error", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const activities: import("@lrm/coforge-sdk/internal").AgentActivity[] = [];
    let listener: Parameters<AgentSession["subscribe"]>[0] = () => undefined;
    let exit: (() => void) | undefined;
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async createAgentSession() {
          return {
            ...sessionSpy(),
            subscribe(next) {
              listener = next;
              return () => undefined;
            },
            onExit(next) {
              exit = next;
              return () => {
                exit = undefined;
              };
            },
          };
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async stop() {},
          sendAgentActivity(activity) {
            activities.push(activity);
          },
          async requestAgentLaunchConfig() {
            return agentLaunchConfig(`sk_agent_${"a".repeat(43)}`);
          },
          async revokeAgentApiKey() {},
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
    );
    await runtime.start(connection);
    await runtime.startAgent("agent-a", config);
    listener({ type: "completed", status: "completed" });
    listener({ type: "error", message: "code agent process exited unexpectedly" });
    exit?.();
    expect(activities.map(({ detailKind }) => detailKind)).toEqual([
      "starting",
      "idle",
      "runtime_error",
      "runtime_crashed",
    ]);
    expect(activities.at(-1)).toMatchObject({
      level: "error",
      detail: "Crashed (code agent process exited unexpectedly)",
    });
    await runtime.stop();
  });
  test("keeps the stopped wording on an unintentional exit with no unresolved error", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const activities: import("@lrm/coforge-sdk/internal").AgentActivity[] = [];
    let exit: (() => void) | undefined;
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async createAgentSession() {
          return {
            ...sessionSpy(),
            onExit(next) {
              exit = next;
              return () => {
                exit = undefined;
              };
            },
          };
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async stop() {},
          sendAgentActivity(activity) {
            activities.push(activity);
          },
          async requestAgentLaunchConfig() {
            return agentLaunchConfig(`sk_agent_${"a".repeat(43)}`);
          },
          async revokeAgentApiKey() {},
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
    );
    await runtime.start(connection);
    await runtime.startAgent("agent-a", config);
    exit?.();
    expect(activities.map(({ detailKind }) => detailKind)).toEqual(["starting", "stopped"]);
    await runtime.stop();
  });
  test("publishes a completion Activity with Idle detail for a successful turn", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const activities: import("@lrm/coforge-sdk/internal").AgentActivity[] = [];
    let listener: Parameters<AgentSession["subscribe"]>[0] = () => undefined;
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async createAgentSession() {
          return {
            ...sessionSpy(),
            subscribe(next) {
              listener = next;
              return () => undefined;
            },
          };
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async stop() {},
          sendAgentActivity(activity) {
            activities.push(activity);
          },
          async requestAgentLaunchConfig() {
            return agentLaunchConfig(`sk_agent_${"a".repeat(43)}`);
          },
          async revokeAgentApiKey() {},
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
    );
    try {
      await runtime.start(connection);
      await runtime.startAgent("agent-a", config);
      listener({ type: "completed", status: "completed" });
      await Bun.sleep(10);
      expect(activities.map(({ detailKind }) => detailKind)).toEqual(["starting", "idle"]);
      expect(activities[0]).toMatchObject({ detailKind: "starting", detail: "Starting…" });
      expect(activities.at(-1)).toMatchObject({
        detailKind: "idle",
        level: "info",
        detail: "Idle",
      });
    } finally {
      await runtime.stop();
    }
  });
  test("reports a fenced fresh session and an honest notice without exposing unrelated provider errors", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const activities: import("@lrm/coforge-sdk/internal").AgentActivity[] = [];
    let fail = false;
    const reports: import("@lrm/coforge-sdk/internal").AgentSessionReport[] = [];
    const invalidations: import("@lrm/coforge-sdk/internal").AgentSessionInvalidate[] = [];
    const order: string[] = [];
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async createAgentSession(options) {
          if (fail) throw new Error("private-provider-token");
          await options.onSessionId?.("new-session", "old-session");
          return sessionSpy();
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async stop() {},
          sendAgentActivity(activity) {
            activities.push(activity);
          },
          async requestAgentLaunchConfig() {
            return agentLaunchConfig(`sk_agent_${"a".repeat(43)}`);
          },
          async revokeAgentApiKey() {},
          sendSessionInvalidate(message) {
            order.push("invalidate");
            invalidations.push(message);
          },
          async reportAgentSession(report) {
            order.push("report");
            reports.push(report);
          },
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
    );
    try {
      await runtime.start(connection);
      await runtime.startAgent("agent-a", config, "old-session", "cloud-start");
      expect(order).toEqual(["invalidate", "report"]);
      expect(invalidations).toHaveLength(1);
      expect(invalidations[0]).toMatchObject({
        sessionId: "old-session",
        reason: "missing",
      });
      expect(invalidations[0]).not.toHaveProperty("startRequestId");
      expect(invalidations[0]).not.toHaveProperty("controlEpoch");
      expect(reports[0]).toMatchObject({
        sessionId: "new-session",
        replacedSessionId: "old-session",
        startRequestId: "cloud-start",
      });
      expect(
        activities.some(
          (activity) =>
            activity.detailKind === "runtime_unavailable" &&
            activity.detail === "Stored Pi session missing; cold-starting a new session…" &&
            activity.entries?.some(
              (entry) =>
                entry.kind === "text" &&
                entry.text ===
                  "Stored Pi session old-session is unavailable locally. Falling back to a cold start; earlier runtime context may not be restored.",
            ),
        ),
      ).toBe(true);
      fail = true;
      await expect(runtime.startAgent("agent-b", config)).rejects.toThrow("private-provider-token");
      expect(activities.at(-1)?.detail).toBe(
        "Agent runtime could not be started. See `coforge-computer logs` for the cause, then start the Agent again.",
      );
      expect(JSON.stringify(activities)).not.toContain("private-provider-token");
    } finally {
      await runtime.stop();
    }
  });
  test("sends a context-window reading once and de-duplicates an unchanged repeat", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    let listener: (event: AgentRuntimeEvent) => void = () => undefined;
    const readings: import("@lrm/coforge-sdk/internal").AgentContextUsage[] = [];
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async createAgentSession() {
          return {
            ...sessionSpy(),
            subscribe(next) {
              listener = next;
              return () => undefined;
            },
          };
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async stop() {},
          async requestAgentLaunchConfig() {
            return agentLaunchConfig(`sk_agent_${"a".repeat(43)}`);
          },
          async revokeAgentApiKey() {},
          sendAgentContextUsage(message) {
            readings.push(message);
          },
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
    );
    try {
      await runtime.start(connection);
      await runtime.startAgent("agent-a", config, "known-session");
      listener({
        type: AGENT_RUNTIME_EVENT_TYPE.CONTEXT_USAGE,
        usedTokens: 27908,
        windowTokens: 200000,
      });
      listener({
        type: AGENT_RUNTIME_EVENT_TYPE.CONTEXT_USAGE,
        usedTokens: 27908,
        windowTokens: 200000,
      });
      expect(readings).toHaveLength(1);
      expect(readings[0]).toMatchObject({
        agentId: "agent-a",
        provider: "pi",
        sessionId: "known-session",
        usedTokens: 27908,
        windowTokens: 200000,
        clientSeq: 1,
      });
      listener({
        type: AGENT_RUNTIME_EVENT_TYPE.CONTEXT_USAGE,
        usedTokens: 40000,
        windowTokens: 200000,
      });
      expect(readings).toHaveLength(2);
      expect(readings[1]).toMatchObject({ usedTokens: 40000, clientSeq: 2 });
    } finally {
      await runtime.stop();
    }
  });
  test.each(["stop", "exit"] as const)(
    "%s resets context-window readings for a new launch without resetting another Agent",
    async (ending) => {
      const credentials = new InMemoryDaemonCredentialStore();
      await credentials.save(connection.workspaceId, connection.computerId, "token-a");
      const sessions = new Map<string, ReturnType<typeof deliveryGateSession>>();
      const readings: import("@lrm/coforge-sdk/internal").AgentContextUsage[] = [];
      const runtime = new DaemonRuntime(
        connection,
        () => ({
          provider: "pi",
          async createAgentSession(options) {
            if (!options.agentId) throw new Error("Test session requires an Agent ID");
            const fake = deliveryGateSession();
            sessions.set(options.agentId, fake);
            return fake.session;
          },
        }),
        credentials,
        {
          create: () => ({
            async start() {},
            async ready() {},
            async stop() {},
            async requestAgentLaunchConfig() {
              return agentLaunchConfig(`sk_agent_${"a".repeat(43)}`);
            },
            async revokeAgentApiKey() {},
            sendAgentContextUsage(message) {
              readings.push(message);
            },
          }),
        },
        undefined,
        emptyCodeAgentDiscovery,
      );
      const reading = {
        type: AGENT_RUNTIME_EVENT_TYPE.CONTEXT_USAGE,
        usedTokens: 27908,
        windowTokens: 200000,
      } as const;
      try {
        await runtime.start(connection);
        await runtime.startAgent("agent-a", config, "session-a-first");
        await runtime.startAgent("agent-b", config, "session-b");
        sessions.get("agent-a")!.emit(reading);
        sessions.get("agent-b")!.emit(reading);
        expect(readings.map(({ agentId, sessionId }) => [agentId, sessionId])).toEqual([
          ["agent-a", "session-a-first"],
          ["agent-b", "session-b"],
        ]);
        if (ending === "stop") await runtime.stopAgent("agent-a");
        else sessions.get("agent-a")!.exit();
        await runtime.startAgent("agent-a", config, "session-a-next");
        sessions.get("agent-a")!.emit(reading);
        sessions.get("agent-b")!.emit(reading);
        expect(readings.map(({ agentId, sessionId }) => [agentId, sessionId])).toEqual([
          ["agent-a", "session-a-first"],
          ["agent-b", "session-b"],
          ["agent-a", "session-a-next"],
        ]);
        expect(readings.at(-1)).toMatchObject({ usedTokens: 27908, windowTokens: 200000 });
      } finally {
        await runtime.stop();
      }
    },
  );
  test.each([
    ["delayed", "empty"],
    ["repeated", "empty"],
    ["delayed", "text-delta"],
    ["delayed", "thinking-delta"],
  ] as const)(
    "a %s old Session exit with %s output preserves the replacement launch's reading and compaction",
    async (exitMode, pendingOutput) => {
      const credentials = new InMemoryDaemonCredentialStore();
      await credentials.save(connection.workspaceId, connection.computerId, "token-a");
      const sessions: ReturnType<typeof deliveryGateSession>[] = [];
      const readings: import("@lrm/coforge-sdk/internal").AgentContextUsage[] = [];
      const activities: import("@lrm/coforge-sdk/internal").AgentActivity[] = [];
      const runtime = new DaemonRuntime(
        connection,
        () => ({
          provider: "pi",
          async createAgentSession() {
            const fake = deliveryGateSession();
            sessions.push(fake);
            return {
              ...fake.session,
              async dispose() {
                if (exitMode === "repeated") fake.exit();
              },
            };
          },
        }),
        credentials,
        {
          create: () => ({
            async start() {},
            async ready() {},
            async stop() {},
            async requestAgentLaunchConfig() {
              return agentLaunchConfig(`sk_agent_${"a".repeat(43)}`);
            },
            async revokeAgentApiKey() {},
            sendAgentContextUsage(message) {
              readings.push(message);
            },
            sendAgentActivity(message) {
              activities.push(message);
            },
          }),
        },
        undefined,
        emptyCodeAgentDiscovery,
      );
      const reading = {
        type: AGENT_RUNTIME_EVENT_TYPE.CONTEXT_USAGE,
        usedTokens: 27908,
        windowTokens: 200000,
      } as const;
      try {
        await runtime.start(connection);
        await runtime.startAgent("agent-a", config, "session-first");
        sessions[0]!.emit(reading);
        if (pendingOutput !== "empty") {
          jest.useFakeTimers();
          sessions[0]!.emit({ type: pendingOutput, text: "Old launch output" });
        }
        await runtime.stopAgent("agent-a");
        await runtime.startAgent("agent-a", config, "session-next");
        activities.length = 0;
        sessions[1]!.emit(reading);
        sessions[1]!.emit({ type: "compaction-started" });
        expect(readings.map(({ sessionId }) => sessionId)).toEqual([
          "session-first",
          "session-next",
        ]);
        expect(activities.map(({ detailKind }) => detailKind)).toEqual(["compacting_context"]);
        sessions[0]!.exit();
        sessions[1]!.emit(reading);
        sessions[1]!.emit({ type: "compaction-finished" });
        expect({
          readingSessions: readings.map(({ sessionId }) => sessionId),
          compaction: activities.map(({ detailKind }) => detailKind),
        }).toEqual({
          readingSessions: ["session-first", "session-next"],
          compaction: ["compacting_context", "compaction_finished"],
        });
      } finally {
        try {
          await runtime.stop();
        } finally {
          jest.useRealTimers();
        }
      }
    },
  );
  test("skips a context-window reading while the current native session id is not yet known", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    let listener: (event: AgentRuntimeEvent) => void = () => undefined;
    const readings: import("@lrm/coforge-sdk/internal").AgentContextUsage[] = [];
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async createAgentSession() {
          return {
            ...sessionSpy(),
            subscribe(next) {
              listener = next;
              return () => undefined;
            },
          };
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async stop() {},
          async requestAgentLaunchConfig() {
            return agentLaunchConfig(`sk_agent_${"a".repeat(43)}`);
          },
          async revokeAgentApiKey() {},
          sendAgentContextUsage(message) {
            readings.push(message);
          },
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
    );
    try {
      await runtime.start(connection);
      await runtime.startAgent("agent-a", config);
      listener({
        type: AGENT_RUNTIME_EVENT_TYPE.CONTEXT_USAGE,
        usedTokens: 10,
        windowTokens: 200000,
      });
      expect(readings).toHaveLength(0);
    } finally {
      await runtime.stop();
    }
  });
  test.each([
    ["session_missing", "missing"],
    ["provider_replay_rejected", "provider_replay_rejected"],
  ] as const)(
    "reports exactly one session invalidate with the correct reason for a kiro/pi retry (%s)",
    async (code, reason) => {
      const stateDirectory = join(tempRoot, `coforge-retry-invalidate-${crypto.randomUUID()}`);
      const credentials = new InMemoryDaemonCredentialStore();
      await credentials.save(connection.workspaceId, connection.computerId, "token-a");
      const invalidations: import("@lrm/coforge-sdk/internal").AgentSessionInvalidate[] = [];
      const activities: import("@lrm/coforge-sdk/internal").AgentActivity[] = [];
      const notices: string[] = [];
      let attempts = 0;
      const runtime = new DaemonRuntime(
        connection,
        () => ({
          provider: "kiro",
          async createAgentSession(options) {
            attempts++;
            if (options.sessionId) throw new AgentSessionRecoveryError(code);
            return {
              ...sessionSpy(),
              async notify(notice: string) {
                notices.push(notice);
              },
            };
          },
        }),
        credentials,
        {
          create: () => ({
            async start() {},
            async ready() {},
            async stop() {},
            sendAgentActivity(activity) {
              activities.push(activity);
            },
            async requestAgentLaunchConfig() {
              return agentLaunchConfig(`sk_agent_${"a".repeat(43)}`);
            },
            async revokeAgentApiKey() {},
            sendSessionInvalidate(message) {
              invalidations.push(message);
            },
            async sendAgentControlResult() {},
            async reportAgentSession() {},
          }),
        },
        undefined,
        emptyCodeAgentDiscovery,
        stateDirectory,
      );
      const intent = {
        protocolMajor: 1,
        requestId: "retry-start",
        workspaceId: connection.workspaceId,
        computerId: connection.computerId,
        agentId: `retry-agent-${code}`,
        provider: "kiro" as const,
        model: "default",
        modelProvider: "anthropic",
        reasoning: "balanced",
        controlEpoch: 1,
        launchId: "launch-retry-stale",
        sessionId: "stale-session",
        sessionMode: "resume" as const,
      };
      try {
        await runtime.start(connection);
        await runtime.handleAgentStart(intent);
        expect(attempts).toBe(2);
        expect(invalidations).toHaveLength(1);
        expect(invalidations[0]).toMatchObject({ sessionId: "stale-session", reason });
        expect(invalidations[0]).not.toHaveProperty("startRequestId");
        expect(invalidations[0]).not.toHaveProperty("controlEpoch");
        expect(
          activities.filter((activity) => activity.detailKind === "runtime_unavailable"),
        ).toHaveLength(1);
        await Bun.sleep(10);
        expect(notices).toEqual([]);
      } finally {
        await runtime.stop();
        await rm(stateDirectory, { recursive: true, force: true });
      }
    },
  );
  test("session_in_use retries without reporting any session invalidate or cold-start Activity", async () => {
    const stateDirectory = join(tempRoot, `coforge-retry-invalidate-busy-${crypto.randomUUID()}`);
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const invalidations: import("@lrm/coforge-sdk/internal").AgentSessionInvalidate[] = [];
    const activities: import("@lrm/coforge-sdk/internal").AgentActivity[] = [];
    let attempts = 0;
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "kiro",
        async createAgentSession(options) {
          attempts++;
          if (options.sessionId) throw new AgentSessionRecoveryError("session_in_use");
          return sessionSpy();
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async stop() {},
          sendAgentActivity(activity) {
            activities.push(activity);
          },
          async requestAgentLaunchConfig() {
            return agentLaunchConfig(`sk_agent_${"a".repeat(43)}`);
          },
          async revokeAgentApiKey() {},
          sendSessionInvalidate(message) {
            invalidations.push(message);
          },
          async sendAgentControlResult() {},
          async reportAgentSession() {},
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
      stateDirectory,
    );
    const intent = {
      protocolMajor: 1,
      requestId: "retry-start-busy",
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      agentId: "retry-agent-busy",
      provider: "kiro" as const,
      model: "default",
      modelProvider: "anthropic",
      reasoning: "balanced",
      controlEpoch: 1,
      launchId: "launch-retry-busy",
      sessionId: "busy-session",
      sessionMode: "resume" as const,
    };
    try {
      await runtime.start(connection);
      await runtime.handleAgentStart(intent);
      expect(attempts).toBe(2);
      expect(invalidations).toHaveLength(0);
      expect(activities.some((activity) => activity.detailKind === "runtime_unavailable")).toBe(
        false,
      );
    } finally {
      await runtime.stop();
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });
  test("reports a safe launch failure while startup cleanup stays unresolved", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const lifecycle: string[] = [];
    const activities: import("@lrm/coforge-sdk/internal").AgentActivity[] = [];
    let credentialRequests = 0;
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async createAgentSession() {
          throw new AgentProcessCleanupError();
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async stop() {},
          sendAgentStatus(status) {
            lifecycle.push(`status:${status.status}`);
          },
          sendAgentActivity(activity) {
            activities.push(activity);
            lifecycle.push(`activity:${activity.detailKind}`);
          },
          async requestAgentLaunchConfig() {
            credentialRequests++;
            return agentLaunchConfig(`sk_agent_${"a".repeat(43)}`);
          },
          async revokeAgentApiKey() {},
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
    );
    await runtime.start(connection);
    await expect(runtime.startAgent("agent-a", config)).rejects.toThrow(
      "process tree did not exit",
    );
    expect(lifecycle).toEqual(["status:inactive", "activity:runtime_error"]);
    expect(activities.map(({ detailKind }) => detailKind)).toEqual(["runtime_error"]);
    expect(activities[0]).toMatchObject({
      agentId: "agent-a",
      detailKind: "runtime_error",
      level: "error",
      clientSeq: 1,
    });
    expect(activities[0]?.detail).not.toContain("Start again to clear");
    await expect(runtime.startAgent("agent-a", config)).rejects.toThrow();
    expect(credentialRequests).toBe(2);
    await runtime.stop().catch(() => undefined);
  });
  test("a stop completes without a runtime_error when process-tree exit cannot be confirmed", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const activities: import("@lrm/coforge-sdk/internal").AgentActivity[] = [];
    const statuses: string[] = [];
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async createAgentSession() {
          return {
            ...sessionSpy(),
            async dispose() {
              throw new AgentProcessCleanupError();
            },
          };
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async stop() {},
          sendAgentStatus(status) {
            statuses.push(status.status);
          },
          sendAgentActivity(activity) {
            activities.push(activity);
          },
          async requestAgentLaunchConfig() {
            return agentLaunchConfig(`sk_agent_${"b".repeat(43)}`);
          },
          async revokeAgentApiKey() {},
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
    );
    await runtime.start(connection);
    await runtime.handleAgentStart({
      protocolMajor: 1,
      requestId: "start-stop-failure",
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      agentId: "agent-a",
      provider: "pi",
      model: "default",
      reasoning: "balanced",
    });
    await expect(runtime.stopAgent("agent-a")).resolves.toBeUndefined();
    expect(activities.map(({ detailKind }) => detailKind)).not.toContain("runtime_error");
    expect(statuses.at(-1)).toBe("inactive");
    expect(runtime.agentProcessManager.size).toBe(0);
    await runtime.stop().catch(() => undefined);
  });
  test("does not publish an old session exit after daemon stop and restart", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const activities: import("@lrm/coforge-sdk/internal").AgentActivity[] = [];
    const oldExitListeners: Array<() => void> = [];
    let launches = 0;
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async createAgentSession() {
          launches++;
          const listeners = launches === 1 ? oldExitListeners : [];
          return {
            ...sessionSpy(),
            onExit(listener) {
              listeners.push(listener);
              return () => undefined;
            },
          };
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async stop() {},
          sendAgentActivity(activity) {
            activities.push(activity);
          },
          async requestAgentLaunchConfig() {
            return agentLaunchConfig(`sk_agent_${String.fromCharCode(97 + launches).repeat(43)}`);
          },
          async revokeAgentApiKey() {},
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
    );
    const intent = {
      protocolMajor: 1,
      requestId: "old-launch",
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      agentId: "agent-a",
      provider: "pi" as const,
      model: "default",
      reasoning: "balanced",
    };
    await runtime.start(connection);
    await runtime.handleAgentStart(intent);
    await runtime.stop();
    await runtime.start(connection);
    await runtime.handleAgentStart({ ...intent, requestId: "new-launch" });
    const beforeDelayedExit = activities.length;
    for (const listener of oldExitListeners) listener();
    expect(activities).toHaveLength(beforeDelayedExit);
    expect(activities.at(-1)?.requestId).toBe("new-launch");
    await runtime.stop();
  });
  test("a failed remote revoke at shutdown is attempted once and closes local access first", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    let attempts = 0;
    let releaseStop!: () => void;
    const stopGate = new Promise<void>((resolve) => (releaseStop = resolve));
    const proxyRevokes: string[] = [];
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async createAgentSession() {
          return sessionSpy();
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async stop() {
            await stopGate;
          },
          async requestAgentLaunchConfig() {
            return agentLaunchConfig(`sk_agent_${"c".repeat(43)}`);
          },
          async revokeAgentApiKey() {
            attempts++;
            if (attempts === 1) throw new Error("offline");
          },
        }),
      },
      { url: "http://proxy", issue: () => "proxy-token", revoke: (id) => proxyRevokes.push(id) },
      emptyCodeAgentDiscovery,
    );
    await runtime.start(connection);
    await runtime.startAgent("agent-a", config);
    const stopping = runtime.stop();
    expect(proxyRevokes).toEqual(["proxy-token"]);
    await expect(runtime.startAgent("agent-b", config)).rejects.toThrow("not running");
    await expect(
      runtime.agentMessage(
        "proxy-token",
        {
          idempotencyKey: "r",
          operation: "check",
          context: "proxy-token",
        },
        `sk_agent_${"a".repeat(43)}`,
      ),
    ).rejects.toThrow("not running");
    releaseStop();
    await expect(stopping).resolves.toBeUndefined();
    await runtime.stop();
    expect(attempts).toBe(1);
  });
  test("shutdown sends one authenticated revoke per running Agent and always recreates the transport", async () => {
    const configuredConnection = {
      ...connection,
      serverHttpUrl: "https://server.example/api/internal/centrifugo",
    };
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "daemon-token");
    const credential = `sk_agent_${"d".repeat(43)}`;
    const revokeAuthorizations: Array<string | null> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        if (String(input) !== "https://server.example/api/agent-api-keys")
          return new Response(null, { status: 503 });
        if (init?.method === "POST") return Response.json({ apiKey: credential });
        revokeAuthorizations.push(new Headers(init?.headers).get("authorization"));
        return new Response(null, { status: 503 });
      },
      { preconnect: originalFetch.preconnect },
    );
    let transportsCreated = 0;
    const runtime = new DaemonRuntime(
      configuredConnection,
      () => ({ provider: "pi", createAgentSession: async () => sessionSpy() }),
      credentials,
      {
        create: () => {
          transportsCreated++;
          return new DaemonConnection("wss://cloud.example", () => connectedClient());
        },
      },
      undefined,
      emptyCodeAgentDiscovery,
    );
    try {
      await runtime.start(configuredConnection);
      await runtime.startAgent("agent-a", config);
      for (const [url, method] of [
        ["https://unrelated.example/resource", "GET"],
        ["https://server.example/unrelated", "DELETE"],
      ] as const)
        await fetch(url, { method, headers: { authorization: "Bearer unrelated-fixture" } });
      await expect(runtime.stop()).resolves.toBeUndefined();
      await runtime.stop();
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(revokeAuthorizations).toEqual(["Bearer daemon-token"]);
    expect(transportsCreated).toBe(3);
  });
  test("keeps App notices separate from Message state and drains them on normalized idle", async () => {
    const stateDirectory = join(tempRoot, `coforge-inbox-runtime-${crypto.randomUUID()}`);
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const notices: string[] = [];
    let listener: ((event: AgentRuntimeEvent) => void) | undefined;
    const exits = new Set<() => void>();
    let starts = 0;
    let cloudMessageCalls = 0;
    let deliveryAcks = 0;
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        createAgentSession: async () => {
          starts++;
          return {
            ...sessionSpy(),
            notify: async (notice) => {
              notices.push(notice);
            },
            subscribe(next) {
              listener = next;
              return () => {
                listener = undefined;
              };
            },
            onExit(next) {
              exits.add(next);
              return () => exits.delete(next);
            },
          };
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async stop() {},
          async requestAgentApiKey() {
            return `sk_agent_${"a".repeat(43)}`;
          },
          async revokeAgentApiKey() {},
          async sendAgentDeliveryAck() {
            deliveryAcks++;
          },
          async agentMessage() {
            cloudMessageCalls++;
            throw new Error("must not read cloud");
          },
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
      stateDirectory,
    );
    try {
      await runtime.start(connection);
      const input = {
        appId: "system.reminder",
        notificationClass: "due",
        sourceRef: { kind: "reminder", id: "123e4567-e89b-42d3-a456-426614174000", revision: "1" },
        title: "Due",
        summary: "Now",
      };
      await runtime.mintAppItem("agent-a", input);
      expect(notices).toEqual([]);
      await runtime.startAgent("agent-a", config);
      await Bun.sleep(10);
      expect(notices).toEqual([expect.stringContaining("Reminder due:")]);
      listener?.({
        type: "activity",
        activity: {
          detailKind: "idle",
          level: "info",
          detail: "idle",
          observedAtMs: Date.now(),
        },
      });
      await Bun.sleep(10);
      expect(notices).toEqual([expect.stringContaining("Reminder due:")]);
      for (const exit of exits) exit();
      await runtime.mintAppItem("agent-a", {
        ...input,
        sourceRef: { ...input.sourceRef, revision: "2" },
      });
      expect(starts).toBe(2);
      expect(notices).toHaveLength(2);
      await runtime.handleAgentMessage({
        protocolMajor: 1,
        requestId: "delivery-request",
        messageId: "message-1",
        deliveryId: "delivery-1",
        sequence: 1,
        workspaceId: connection.workspaceId,
        conversationId: "conversation-a",
        agentId: "agent-a",
        body: "private chat body",
        method: "agent:v1:message:deliver",
        target: "@ada",
      });
      await runtime.drainAppInboxNotices("agent-a");
      expect(notices).toHaveLength(3);
      const context = runtime.issueAgentContext("agent-a");
      const snapshot = await runtime.inbox(context, {
        idempotencyKey: "check",
        context,
        operation: "check",
      });
      expect(snapshot.entries.map((entry) => entry.kind).sort()).toEqual([
        "app",
        "app",
        "message_target",
      ]);
      const unchanged = await runtime.inbox(context, {
        idempotencyKey: "check-again",
        context,
        operation: "check",
      });
      expect(unchanged.entries.map((entry) => entry.kind).sort()).toEqual([
        "app",
        "app",
        "message_target",
      ]);
      expect(cloudMessageCalls).toBe(0);
      expect(deliveryAcks).toBe(1);
      await runtime.mintAppItem("agent-a", input);
      expect(notices).toHaveLength(3);
      expect(cloudMessageCalls).toBe(0);
      expect(deliveryAcks).toBe(1);
    } finally {
      await runtime.stop();
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });
  test("a reminder whose wake notice is refused keeps its App Inbox item and counts as delivered", async () => {
    const stateDirectory = join(tempRoot, `coforge-reminder-notice-${crypto.randomUUID()}`);
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const notify = Promise.withResolvers<void>();
    const notifyStarted = Promise.withResolvers<void>();
    const exits = new Set<() => void>();
    let sessions = 0;
    let receiveReminder!: (due: ReminderDue) => void;
    const reminderId = "123e4567-e89b-42d3-a456-426614174000";
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async createAgentSession() {
          sessions++;
          return {
            ...sessionSpy(),
            ...(sessions === 2
              ? {
                  notify: async () => {
                    notifyStarted.resolve();
                    await notify.promise;
                  },
                }
              : {}),
            onExit(next) {
              exits.add(next);
              return () => exits.delete(next);
            },
          };
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async stop() {},
          onReminderDue(callback) {
            receiveReminder = callback;
            return () => undefined;
          },
          async acknowledgeReminderDue() {
            return true;
          },
          async requestAgentLaunchConfig() {
            return agentLaunchConfig(`sk_agent_${"a".repeat(43)}`);
          },
          async revokeAgentApiKey() {},
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
      stateDirectory,
    );
    try {
      await runtime.start(connection);
      await runtime.startAgent("agent-a", config);
      for (const exit of exits) exit();
      receiveReminder(
        reminderDue({
          reminderId,
          ownerAgentId: "agent-a",
          version: 1,
          title: "Retry me",
          target: "@frank",
          messageId: "123e4567-e89b-42d3-a456-426614174001",
          fireAt: new Date(Date.now() - 1000).toISOString(),
        }),
      );
      await notifyStarted.promise;
      const concurrentDrain = runtime.drainAppInboxNotices("agent-a");
      notify.reject(new Error("notify rejected"));
      await expect(concurrentDrain).rejects.toThrow("notify rejected");
      await waitFor(async () => (await reminderDueStates(stateDirectory))[0] === "delivered");
      const context = runtime.issueAgentContext("agent-a");
      const inbox = await runtime.inbox(context, {
        idempotencyKey: "check-refused-notice",
        context,
        operation: "check",
      });
      expect(inbox.entries.filter((entry) => entry.kind === "app")).toHaveLength(1);
    } finally {
      notify.resolve();
      await runtime.stop();
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });
  test("a reminder that reaches the Agent hours after its due time says it is overdue", async () => {
    const stateDirectory = join(tempRoot, `coforge-reminder-late-${crypto.randomUUID()}`);
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const notified = Promise.withResolvers<void>();
    let receiveReminder!: (due: ReminderDue) => void;
    const dueAt = new Date(Date.now() - 2 * 60 * 60000).toISOString();
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async createAgentSession() {
          return { ...sessionSpy(), notify: async () => notified.resolve() };
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async stop() {},
          onReminderDue(callback) {
            receiveReminder = callback;
            return () => undefined;
          },
          async acknowledgeReminderDue() {
            return true;
          },
          async requestAgentLaunchConfig() {
            return agentLaunchConfig(`sk_agent_${"a".repeat(43)}`);
          },
          async revokeAgentApiKey() {},
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
      stateDirectory,
    );
    try {
      await runtime.start(connection);
      await runtime.startAgent("agent-a", config);
      receiveReminder(
        reminderDue({
          reminderId: "123e4567-e89b-42d3-a456-426614174000",
          ownerAgentId: "agent-a",
          version: 1,
          title: "Check the build",
          target: "@frank",
          messageId: "123e4567-e89b-42d3-a456-426614174001",
          fireAt: dueAt,
        }),
      );
      await notified.promise;
      const context = runtime.issueAgentContext("agent-a");
      const inbox = await runtime.inbox(context, {
        idempotencyKey: "check-reminder",
        context,
        operation: "check",
      });
      const app = inbox.entries[0]?.kind === "app" ? inbox.entries[0].app : undefined;
      expect(app?.summary).toBe(`Overdue: was due ${dueAt}, delivered late`);
    } finally {
      await runtime.stop();
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });
  describe("a stop with a reminder Due ACK in flight", () => {
    async function withFireInFlight(
      run: (harness: {
        runtime: DaemonRuntime;
        stateDirectory: string;
        fireStarted: Promise<void>;
        answerFire: () => void;
        fireAnswered: () => boolean;
      }) => Promise<void>,
    ) {
      const stateDirectory = join(tempRoot, `coforge-reminder-stop-${crypto.randomUUID()}`);
      const credentials = new InMemoryDaemonCredentialStore();
      await credentials.save(connection.workspaceId, connection.computerId, "token-a");
      const fireStarted = Promise.withResolvers<void>();
      const answer = Promise.withResolvers<void>();
      let answered = false;
      let receiveReminder!: (due: ReminderDue) => void;
      const runtime = new DaemonRuntime(
        connection,
        () => ({ provider: "pi", createAgentSession: async () => sessionSpy() }),
        credentials,
        {
          create: () => ({
            async start() {},
            async ready() {},
            async stop() {},
            onReminderDue(callback) {
              receiveReminder = callback;
              return () => undefined;
            },
            async acknowledgeReminderDue() {
              fireStarted.resolve();
              await answer.promise;
              answered = true;
              return true;
            },
            async revokeAgentApiKey() {},
          }),
        },
        undefined,
        emptyCodeAgentDiscovery,
        stateDirectory,
      );
      try {
        await runtime.start(connection);
        receiveReminder(
          reminderDue({
            reminderId: "123e4567-e89b-42d3-a456-426614174000",
            ownerAgentId: "agent-a",
            version: 1,
            title: "Check the build",
            target: "@frank",
            messageId: "123e4567-e89b-42d3-a456-426614174001",
            fireAt: new Date(Date.now() - 1000).toISOString(),
          }),
        );
        await fireStarted.promise;
        await run({
          runtime,
          stateDirectory,
          fireStarted: fireStarted.promise,
          answerFire: answer.resolve,
          fireAnswered: () => answered,
        });
      } finally {
        answer.resolve();
        await runtime.stop();
        await rm(stateDirectory, { recursive: true, force: true });
      }
    }
    test("does not finish until the request has settled, and the late answer changes nothing", async () => {
      await withFireInFlight(async ({ runtime, stateDirectory, answerFire, fireAnswered }) => {
        const stopping = runtime.stop();
        const early = await Promise.race([
          stopping.then(() => "stopped" as const),
          new Promise<"still stopping">((resolve) =>
            setTimeout(() => resolve("still stopping"), 100),
          ),
        ]);
        expect(early).toBe("still stopping");
        answerFire();
        await stopping;
        expect(fireAnswered()).toBe(true);
        expect(await reminderDueStates(stateDirectory)).toEqual(["acknowledged"]);
      });
    });
    test(
      "gives up after the shutdown bound when the request never settles, and says so",
      async () => {
        await withFireInFlight(async ({ runtime, fireAnswered }) => {
          const { records } = await captureDaemonLogs(() => runtime.stop());
          expect(fireAnswered()).toBe(false);
          const gaveUp = records.filter(
            (record) => record.properties.event === "daemon_runtime:reminder_settle_timed_out",
          );
          expect(gaveUp).toHaveLength(1);
          expect(gaveUp[0]).toMatchObject({
            level: "info",
            properties: { outcome: "unknown", duration_ms: DAEMON_SHUTDOWN_NOTICE_TIMEOUT_MS },
          });
        });
      },
      DAEMON_SHUTDOWN_NOTICE_TIMEOUT_MS + 5000,
    );
  });
  test.each(["deleted", "damaged"] as const)(
    "a delivered reminder can still be acknowledged after its local Due record is %s",
    async (damage) => {
      const stateDirectory = join(tempRoot, `coforge-reminder-lost-receipt-${crypto.randomUUID()}`);
      const credentials = new InMemoryDaemonCredentialStore();
      await credentials.save(connection.workspaceId, connection.computerId, "token-a");
      const reminderId = "123e4567-e89b-42d3-a456-426614174000";
      const agentKey = `sk_agent_${"a".repeat(43)}`;
      const createRuntime = (onNotify: () => void) => {
        let receiveReminder!: (due: ReminderDue) => void;
        const runtime = new DaemonRuntime(
          connection,
          () => ({
            provider: "pi",
            async createAgentSession() {
              return { ...sessionSpy(), notify: async () => onNotify() };
            },
          }),
          credentials,
          {
            create: () => ({
              async start() {},
              async ready() {},
              async stop() {},
              onReminderDue(callback) {
                receiveReminder = callback;
                return () => undefined;
              },
              async acknowledgeReminderDue() {
                return true;
              },
              async requestAgentLaunchConfig() {
                return agentLaunchConfig(agentKey);
              },
              async revokeAgentApiKey() {},
            }),
          },
          undefined,
          emptyCodeAgentDiscovery,
          stateDirectory,
        );
        return {
          runtime,
          receive: (due: ReminderDue) => receiveReminder(due),
        };
      };
      const notified = Promise.withResolvers<void>();
      const first = createRuntime(() => notified.resolve());
      try {
        await first.runtime.start(connection);
        await first.runtime.startAgent("agent-a", config);
        first.receive(
          reminderDue({
            reminderId,
            ownerAgentId: "agent-a",
            version: 1,
            title: "Check the build",
            target: "@frank",
            messageId: "123e4567-e89b-42d3-a456-426614174001",
            fireAt: new Date(Date.now() - 1000).toISOString(),
          }),
        );
        await notified.promise;
      } finally {
        await first.runtime.stop();
      }
      const receiptFile = join(
        stateDirectory,
        "reminder-due",
        connection.workspaceId,
        "agent-a",
        "occurrences.json",
      );
      if (damage === "deleted") await rm(receiptFile, { force: true });
      else await Bun.write(receiptFile, "{ not json");
      if (damage === "deleted") expect(await Bun.file(receiptFile).exists()).toBe(false);
      else expect(await Bun.file(receiptFile).text()).toBe("{ not json");
      const second = createRuntime(() => {});
      try {
        await second.runtime.start(connection);
        await second.runtime.startAgent("agent-a", config);
        const context = second.runtime.issueAgentContext("agent-a");
        const before = await second.runtime.inbox(context, {
          idempotencyKey: "before-ack",
          context,
          operation: "check",
        });
        expect(before.entries).toHaveLength(1);
        expect(
          await second.runtime.reminder(
            context,
            { idempotencyKey: "ack-unknown", context, operation: "ack", reminderId, revision: 2 },
            agentKey,
          ),
        ).toMatchObject({ accepted: false });
        expect(
          await second.runtime.reminder(
            context,
            { idempotencyKey: "ack-lost", context, operation: "ack", reminderId, revision: 1 },
            agentKey,
          ),
        ).toMatchObject({ accepted: true, reminderId, revision: 1 });
        expect(
          (
            await second.runtime.inbox(context, {
              idempotencyKey: "after-ack",
              context,
              operation: "check",
            })
          ).entries,
        ).toEqual([]);
      } finally {
        await second.runtime.stop();
        await rm(stateDirectory, { recursive: true, force: true });
      }
    },
  );
  test("projects a long multiline reminder title into the App Inbox without changing its occurrence", async () => {
    const stateDirectory = join(tempRoot, `coforge-reminder-preview-${crypto.randomUUID()}`);
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const notified = Promise.withResolvers<void>();
    let receiveReminder!: (due: ReminderDue) => void;
    const fullTitle = `  检查\n\t${"中".repeat(115)}😀${"长期项目进度".repeat(30)}  `;
    const reminderId = "123e4567-e89b-42d3-a456-426614174000";
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async createAgentSession() {
          return { ...sessionSpy(), notify: async () => notified.resolve() };
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async stop() {},
          onReminderDue(callback) {
            receiveReminder = callback;
            return () => undefined;
          },
          async acknowledgeReminderDue() {
            return true;
          },
          async requestAgentLaunchConfig() {
            return agentLaunchConfig(`sk_agent_${"a".repeat(43)}`);
          },
          async revokeAgentApiKey() {},
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
      stateDirectory,
    );
    try {
      await runtime.start(connection);
      await runtime.startAgent("agent-a", config);
      receiveReminder(
        reminderDue({
          reminderId,
          ownerAgentId: "agent-a",
          version: 1,
          title: fullTitle,
          target: "@frank",
          messageId: "123e4567-e89b-42d3-a456-426614174001",
          fireAt: new Date(Date.now() - 1000).toISOString(),
        }),
      );
      await notified.promise;
      const context = runtime.issueAgentContext("agent-a");
      const inbox = await runtime.inbox(context, {
        idempotencyKey: "check-reminder",
        context,
        operation: "check",
      });
      const app = inbox.entries[0]?.kind === "app" ? inbox.entries[0].app : undefined;
      expect(app?.title).toHaveLength(120);
      expect(app?.title).not.toMatch(/[\r\n\t]/);
      expect(app?.title).toStartWith("检查 ");
      expect(app?.title).toEndWith("😀");
      expect(app?.summary).toBe("Reminder due");
      const acknowledgement = await runtime.reminder(
        context,
        { idempotencyKey: "ack-reminder", context, operation: "ack", reminderId, revision: 1 },
        `sk_agent_${"a".repeat(43)}`,
      );
      expect(acknowledgement).toMatchObject({ accepted: true, reminderId, revision: 1 });
      expect(
        (await runtime.inbox(context, { idempotencyKey: "after-ack", context, operation: "check" }))
          .entries,
      ).toEqual([]);
      const record = (await Bun.file(
        join(stateDirectory, "reminder-due", connection.workspaceId, "agent-a", "occurrences.json"),
      ).json()) as { occurrences: Array<{ due: { job: { title: string } } }> };
      expect(record.occurrences[0]?.due.job.title).toBe(fullTitle);
    } finally {
      await runtime.stop();
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });
  test("a revoke failure at Stop is logged once and a reconnect never retries it", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    let reconnect: (() => void) | undefined;
    let revokeAttempts = 0;
    const statuses: Array<{
      agentId: string;
      status: string;
    }> = [];
    const activities: Array<{
      agentId: string;
      detailKind: string;
    }> = [];
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async createAgentSession() {
          return sessionSpy();
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async stop() {},
          onReconnect(callback) {
            reconnect = callback;
            return () => {
              reconnect = undefined;
            };
          },
          async requestAgentLaunchConfig() {
            return agentLaunchConfig(`sk_agent_${"a".repeat(43)}`);
          },
          async revokeAgentApiKey() {
            revokeAttempts++;
            throw new Error("remote revoke failed");
          },
          sendAgentStatus({ agentId, status }) {
            statuses.push({ agentId, status });
          },
          async sendAgentActivity(activity) {
            activities.push({ agentId: activity.agentId, detailKind: activity.detailKind });
          },
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
    );
    try {
      await runtime.start(connection);
      await runtime.startAgent("agent-a", config);
      statuses.length = 0;
      activities.length = 0;
      await expect(runtime.stopAgent("agent-a")).resolves.toBeUndefined();
      expect(revokeAttempts).toBe(1);
      expect(statuses.at(-1)).toEqual({ agentId: "agent-a", status: "inactive" });
      expect(
        activities.some((activity) => activity.detailKind === AGENT_ACTIVITY_DETAIL_KIND.STOPPED),
      ).toBe(true);
      reconnect?.();
      await Bun.sleep(0);
      reconnect?.();
      await Bun.sleep(0);
      expect(revokeAttempts).toBe(1);
    } finally {
      await runtime.stop();
    }
  });
  test("a connection the cloud refuses for good stops the running Agents, then reports why", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    let refuse: ((reason: "workspace_deleted") => void) | undefined;
    const events: string[] = [];
    const reported = Promise.withResolvers<string>();
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async createAgentSession() {
          return {
            ...sessionSpy(),
            async dispose() {
              events.push("agent stopped");
            },
          };
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async stop() {},
          onConnectionRefused(callback) {
            refuse = callback;
            return () => {
              refuse = undefined;
            };
          },
          async requestAgentLaunchConfig() {
            return agentLaunchConfig(`sk_agent_${"a".repeat(43)}`);
          },
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
      undefined,
      {
        connectionRefused(reason) {
          events.push(`refused: ${reason}`);
          reported.resolve(reason);
        },
      },
    );
    try {
      await runtime.start(connection);
      await runtime.startAgent("agent-a", config);
      refuse?.("workspace_deleted");
      expect(await reported.promise).toBe("workspace_deleted");
      expect(events).toEqual(["agent stopped", "refused: workspace_deleted"]);
    } finally {
      await runtime.stop();
    }
  });
  test("a reconnect pass never revokes the key a running Agent is still using", async () => {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    let reconnect: (() => void) | undefined;
    const revokedKeys: string[] = [];
    const liveKey = `sk_agent_${"a".repeat(43)}`;
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async createAgentSession() {
          return sessionSpy();
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async stop() {},
          onReconnect(callback) {
            reconnect = callback;
            return () => {
              reconnect = undefined;
            };
          },
          async requestAgentLaunchConfig() {
            return agentLaunchConfig(liveKey);
          },
          async revokeAgentApiKey(agentApiKey) {
            revokedKeys.push(agentApiKey);
          },
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
    );
    try {
      await runtime.start(connection);
      await runtime.startAgent("agent-a", config);
      reconnect?.();
      await Bun.sleep(0);
      reconnect?.();
      await Bun.sleep(0);
      expect(revokedKeys).toEqual([]);
      await runtime.stopAgent("agent-a");
      await Bun.sleep(0);
      expect(revokedKeys).toEqual([liveKey]);
    } finally {
      await runtime.stop();
    }
    expect(revokedKeys).toEqual([liveKey]);
  });
  test("a fenced Start failure logs AgentControl's fixed rejection as a control_code", async () => {
    const stateDirectory = join(
      tempRoot,
      `coforge-start-failure-control-code-${crypto.randomUUID()}`,
    );
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    let listener: ((intent: Parameters<DaemonRuntime["handleAgentStart"]>[0]) => void) | undefined;
    const base = {
      protocolMajor: 1,
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      agentId: "control-code-agent",
      provider: "pi" as const,
      model: "default",
      reasoning: "balanced",
      controlEpoch: 1,
      launchId: "launch-control-code",
    };
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: "pi",
        async createAgentSession() {
          return sessionSpy();
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          onAgentStart(callback) {
            listener = callback;
            return () => {
              listener = undefined;
            };
          },
          async ready() {
            listener?.({ ...base, requestId: "start-1" });
          },
          async requestAgentLaunchConfig() {
            return agentLaunchConfig(`sk_agent_${"a".repeat(43)}`);
          },
          async sendAgentActivity() {},
          sendAgentStatus() {},
          async sendAgentControlResult() {},
          async stop() {},
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
      stateDirectory,
    );
    try {
      const findFailure = (records: readonly LogRecord[]) =>
        records.find((record) => record.properties.event === "agent_runtime:start_failed");
      const { records } = await captureDaemonLogs(async (arrived) => {
        await runtime.start(connection);
        listener?.({ ...base, requestId: "start-2" });
        const deadline = Date.now() + 5000;
        while (!findFailure(arrived) && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 0));
      });
      const failure = findFailure(records);
      expect(failure?.properties).toMatchObject({
        agent_id: "control-code-agent",
        control_code: "control_request_mismatch",
      });
      expect(failure?.properties.error_code).toBe("Error");
    } finally {
      await runtime.stop();
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });
});
describe("Agent delivery queue", () => {
  function deliveryGateHarness(
    provider: AgentRuntimeConfig["provider"],
    acks = ackGate(0),
    stateDirectory?: string,
    onActivity?: (activity: import("@lrm/coforge-sdk/internal").AgentActivity) => void,
    agentConfig: Partial<AgentRuntimeConfig> = {},
  ) {
    return createDeliveryGateHarness({
      connection,
      config,
      provider,
      acks,
      stateDirectory,
      onActivity,
      agentConfig,
    });
  }
  test("a busy Kiro-mode Agent is delivered to immediately too, now that Kiro is steer mode", async () => {
    const acks = ackGate(1);
    const { fake, deliver } = await deliveryGateHarness("kiro", acks);
    fake.emit({ type: "progress" });
    await deliver(1);
    await acks.done;
    expect(fake.notices).toHaveLength(1);
    expect(acks.acks).toEqual(["delivery-1"]);
  });
  test("an idle Kiro-mode Agent still delivers immediately", async () => {
    const acks = ackGate(1);
    const { fake, deliver } = await deliveryGateHarness("kiro", acks);
    await deliver(1);
    await acks.done;
    expect(fake.notices).toHaveLength(1);
    expect(acks.acks).toEqual(["delivery-1"]);
  });
  test("a busy steer-mode Agent (Pi) is delivered to immediately, unchanged by this queue", async () => {
    const acks = ackGate(1);
    const { fake, deliver } = await deliveryGateHarness("pi", acks);
    fake.emit({ type: "progress" });
    await deliver(1);
    await acks.done;
    expect(fake.notices).toHaveLength(1);
    expect(acks.acks).toEqual(["delivery-1"]);
  });
  test("a fallback notice (steer could not deliver it) is held and redelivered once at turn end, without a second ACK", async () => {
    const acks = ackGate(1);
    const { fake, deliver } = await deliveryGateHarness("kiro", acks);
    await deliver(1);
    await acks.done;
    const delivered = fake.notices.length;
    expect(acks.acks).toEqual(["delivery-1"]);
    fake.emit({ type: "notice-undelivered", text: "STEERED-BUT-NEVER-INJECTED" });
    expect(fake.notices).toHaveLength(delivered);
    fake.emit({ type: "completed", status: "completed" });
    await fake.waitForNotices(delivered + 1);
    expect(fake.notices.at(-1)).toBe("STEERED-BUT-NEVER-INJECTED");
    expect(acks.acks).toEqual(["delivery-1"]);
  });
  test("a fallback notice survives an unexpected exit and is redelivered exactly once on the next launch", async () => {
    const acks = ackGate(0);
    const { runtime, fake } = await deliveryGateHarness("kiro", acks);
    fake.emit({ type: "notice-undelivered", text: "STEERED-BUT-NEVER-INJECTED" });
    expect(fake.notices).toEqual([]);
    fake.exit();
    await runtime.startAgent("agent-a", { ...config, provider: "kiro" });
    await fake.waitForNotices(1);
    expect(fake.notices).toEqual(["STEERED-BUT-NEVER-INJECTED"]);
  });
  describe("runtime-error delivery backoff and fingerprint fence", () => {
    afterEach(() => jest.useRealTimers());
    const RECOVERY_EVENTS = [
      ["text", { type: "text-delta", text: "back" }, true, true],
      ["thinking", { type: "thinking-delta", text: "hm" }, true, true],
      ["a tool call", { type: "tool-start", id: "tool-1", name: "bash" }, true, true],
      ["tool output", { type: "tool-output", id: "tool-1", text: "ok" }, true, true],
      ["provider progress", { type: "progress" }, true, false],
      [
        "subagent progress",
        { type: "subagent-progress", phase: "progress", taskId: "task-1" },
        true,
        false,
      ],
      ["a finished compaction", { type: "compaction-finished" }, false, false],
      ["a finished review", { type: "review-finished" }, false, true],
      ["a tool end", { type: "tool-end", id: "tool-1", isError: false }, false, false],
      ["a reconnect", { type: "reconnecting", attempt: 1 }, false, false],
    ] as const satisfies ReadonlyArray<
      readonly [kind: string, event: AgentRuntimeEvent, endsBackoff: boolean, resetsFence: boolean]
    >;
    const runtimeErrorReasons = (
      activities: readonly import("@lrm/coforge-sdk/internal").AgentActivity[],
    ) =>
      activities
        .filter((activity) => activity.detailKind === "runtime_error")
        .map((activity) => activity.runtimeError?.errorReason);
    test("a retryable runtime error holds a new delivery and releases it once the backoff elapses", async () => {
      const acks = ackGate(1);
      const { fake, deliver } = await deliveryGateHarness("pi", acks);
      jest.useFakeTimers();
      fake.emit({ type: "error", message: "connect ECONNRESET" });
      fake.emit({ type: "completed", status: "failed" });
      await deliver(1);
      expect(fake.notices).toEqual([]);
      jest.advanceTimersByTime(10000 * 1.1 + 1);
      await fake.waitForNotices(1);
      await acks.done;
      expect(fake.notices).toHaveLength(1);
    });
    test.each(
      RECOVERY_EVENTS.filter(([, , endsBackoff]) => endsBackoff).map(
        ([kind, event]) => [kind, event] as const,
      ),
    )(
      "runtime progress during a backoff ends it and flushes the held delivery at once (%s)",
      async (_kind, progress) => {
        const acks = ackGate(1);
        const { fake, deliver } = await deliveryGateHarness("pi", acks);
        jest.useFakeTimers();
        fake.emit({ type: "error", message: "502 Bad Gateway" });
        fake.emit({ type: "completed", status: "failed" });
        await deliver(1);
        expect(fake.notices).toEqual([]);
        fake.emit(progress);
        await fake.waitForNotices(1);
        await acks.done;
        expect(fake.notices).toHaveLength(1);
      },
    );
    test.each(
      RECOVERY_EVENTS.filter(([, , endsBackoff]) => !endsBackoff).map(
        ([kind, event]) => [kind, event] as const,
      ),
    )(
      "%s during a backoff leaves the held delivery held until the delay elapses",
      async (_kind, between) => {
        const acks = ackGate(1);
        const { fake, deliver } = await deliveryGateHarness("pi", acks);
        jest.useFakeTimers();
        fake.emit({ type: "error", message: "502 Bad Gateway" });
        await deliver(1);
        fake.emit(between);
        fake.emit({ type: "completed", status: "failed" });
        await acks.done;
        expect(fake.notices).toEqual([]);
        jest.advanceTimersByTime(10000 * 1.1 + 1);
        await fake.waitForNotices(1);
        expect(fake.notices).toHaveLength(1);
      },
    );
    test("output while busy mid-turn ends a backoff, and the held delivery is delivered at that turn's end", async () => {
      const acks = ackGate(1);
      const { fake, deliver } = await deliveryGateHarness("pi", acks);
      jest.useFakeTimers();
      fake.emit({ type: "text-delta", text: "working" });
      fake.emit({ type: "error", message: "429 Too Many Requests" });
      await deliver(1);
      await acks.done;
      fake.emit({ type: "text-delta", text: "back" });
      fake.emit({ type: "completed", status: "completed" });
      await fake.waitForNotices(1);
      expect(fake.notices).toHaveLength(1);
    });
    test.each(
      RECOVERY_EVENTS.map(
        ([kind, event, , resetsFence]) =>
          [kind, resetsFence ? "not fenced" : "fenced", event] as const,
      ),
    )("three identical errors with %s between them: %s", async (_kind, outcome, between) => {
      const activities: import("@lrm/coforge-sdk/internal").AgentActivity[] = [];
      const { runtime, fake } = await deliveryGateHarness("pi", undefined, undefined, (activity) =>
        activities.push(activity),
      );
      try {
        fake.emit({ type: "error", message: "HTTP 403" });
        fake.emit({ type: "error", message: "HTTP 403" });
        fake.emit(between);
        fake.emit({ type: "error", message: "HTTP 403" });
        expect(runtimeErrorReasons(activities)).toEqual([
          "provider_api_error",
          "provider_api_error",
          outcome === "fenced" ? "runtime_error_fenced" : "provider_api_error",
        ]);
      } finally {
        await runtime.stop();
      }
    });
    test.each(["failed", "completed", "interrupted"] as const)(
      "a %s turn end that showed nothing between three identical errors leaves the streak",
      async (status) => {
        const activities: import("@lrm/coforge-sdk/internal").AgentActivity[] = [];
        const { runtime, fake } = await deliveryGateHarness(
          "pi",
          undefined,
          undefined,
          (activity) => activities.push(activity),
        );
        try {
          fake.emit({ type: "error", message: "HTTP 403" });
          fake.emit({ type: "error", message: "HTTP 403" });
          fake.emit({ type: "completed", status });
          fake.emit({ type: "error", message: "HTTP 403" });
          expect(runtimeErrorReasons(activities)).toEqual([
            "provider_api_error",
            "provider_api_error",
            "runtime_error_fenced",
          ]);
        } finally {
          await runtime.stop();
        }
      },
    );
    test("a non-retryable runtime error does not hold the next delivery", async () => {
      const acks = ackGate(1);
      const { fake, deliver } = await deliveryGateHarness("pi", acks);
      fake.emit({ type: "error", message: "the request timed out after 60000ms" });
      await deliver(1);
      await acks.done;
      expect(fake.notices).toHaveLength(1);
    });
    test("output resets the backoff streak, so the next failure starts at the base delay again", async () => {
      const acks = ackGate(2);
      const { fake, deliver } = await deliveryGateHarness("pi", acks);
      jest.useFakeTimers();
      fake.emit({ type: "error", message: "connect ECONNRESET" });
      fake.emit({ type: "completed", status: "failed" });
      await deliver(1);
      jest.advanceTimersByTime(10000 * 1.1 + 1);
      await fake.waitForNotices(1);
      fake.emit({ type: "text-delta", text: "done" });
      fake.emit({ type: "completed", status: "completed" });
      fake.emit({ type: "error", message: "connect ECONNRESET" });
      fake.emit({ type: "completed", status: "failed" });
      await deliver(2);
      jest.advanceTimersByTime(10000 * 1.1 + 1);
      await fake.waitForNotices(2);
      await acks.done;
      expect(fake.notices).toHaveLength(2);
    });
    test("a turn end ends the backoff of an unclassified error and flushes what it held", async () => {
      const acks = ackGate(1);
      const { fake, deliver } = await deliveryGateHarness("pi", acks);
      jest.useFakeTimers();
      fake.emit({ type: "error", message: "something odd happened" });
      await deliver(1);
      expect(fake.notices).toEqual([]);
      fake.emit({ type: "completed", status: "failed" });
      await fake.waitForNotices(1);
      await acks.done;
      expect(fake.notices).toHaveLength(1);
    });
    test.each([
      ["rate limit", "429 Too Many Requests", "failed"],
      ["provider connection", "connect ECONNRESET", "failed"],
      ["rate limit", "429 Too Many Requests", "interrupted"],
      ["rate limit", "429 Too Many Requests", "completed"],
    ] as const)(
      "a classified retryable error's backoff keeps holding across a turn end with no output (%s: %s, turn %s)",
      async (_class, message, status) => {
        const acks = ackGate(1);
        const { fake, deliver } = await deliveryGateHarness("pi", acks);
        jest.useFakeTimers();
        fake.emit({ type: "error", message });
        fake.emit({ type: "completed", status });
        await deliver(1);
        await acks.done;
        expect(fake.notices).toEqual([]);
        jest.advanceTimersByTime(10000 * 1.1 + 1);
        await fake.waitForNotices(1);
        expect(fake.notices).toHaveLength(1);
      },
    );
    test.each([
      ["classified", {}, "ProviderApiError", "provider_api_error"],
      [
        "provider class",
        {
          providerErrorClass: "fixture_native_class",
          providerErrorReason: "fixture_native_reason",
        },
        "fixture_native_class",
        "fixture_native_reason",
      ],
      [
        "provider code",
        { providerErrorCode: "FIXTURE_NATIVE_CODE", providerErrorReason: "fixture_native_reason" },
        "FIXTURE_NATIVE_CODE",
        "fixture_native_reason",
      ],
    ] as const)(
      "three consecutive failures with the same fingerprint trip the fence, reporting it in CoForge's own words (%s)",
      async (_hint, hints, errorClass, errorReason) => {
        const activities: import("@lrm/coforge-sdk/internal").AgentActivity[] = [];
        const { runtime, fake } = await deliveryGateHarness(
          "pi",
          undefined,
          undefined,
          (activity) => activities.push(activity),
        );
        const error = { type: "error", message: "HTTP 403", ...hints } as const;
        jest.useFakeTimers();
        try {
          fake.emit(error);
          const initial = activities.find((activity) => activity.detailKind === "runtime_error");
          expect(initial).toMatchObject({
            agentId: "agent-a",
            detailKind: "runtime_error",
            level: "error",
            detail: "HTTP 403",
            entries: [{ kind: "text", text: "Error: HTTP 403" }],
            runtimeError: { errorClass, errorReason },
          });
          expect(initial!.runtimeError!.fingerprint).toMatch(/^[0-9a-f]{8}$/);
          fake.emit(error);
          activities.length = 0;
          fake.emit(error);
          await fake.disposed;
          const fenced = activities.find((activity) => activity.detailKind === "runtime_error");
          expect(fenced).toBeDefined();
          expect(fenced!.runtimeError?.errorReason).toBe("runtime_error_fenced");
          const detail = `Runtime stopped after 3 repeated runtime errors with the same fingerprint (${initial!.runtimeError!.fingerprint}). Last error: HTTP 403 Restart after the runtime/tooling issue is fixed.`;
          expect(fenced).toMatchObject({
            agentId: "agent-a",
            detailKind: "runtime_error",
            level: "error",
            detail,
            entries: [{ kind: "text", text: `Error: ${detail}` }],
            runtimeError: { errorClass, errorReason: "runtime_error_fenced" },
          });
          expect(fenced!.runtimeError!.fingerprint).toBe(initial!.runtimeError!.fingerprint);
          expect(
            activities.filter((activity) => activity.detailKind === "runtime_error"),
          ).toHaveLength(1);
          activities.length = 0;
          fake.exit();
          fake.emit(error);
          expect(activities).toHaveLength(0);
        } finally {
          await runtime.stop();
        }
      },
    );
    test("a tripped fence takes the Agent offline: it keeps custody of later deliveries until a fresh start", async () => {
      const acks = ackGate(2);
      const { runtime, fake, deliver, statuses, rejections } = await deliveryGateHarness(
        "pi",
        acks,
      );
      for (let attempt = 0; attempt < 3; attempt++)
        fake.emit({ type: "error", message: "something odd happened" });
      await fake.disposed;
      await Bun.sleep(0);
      expect(statuses.at(-1)?.status).toBe("inactive");
      await deliver(1);
      expect(rejections).toEqual([]);
      expect(statuses.at(-1)?.status).toBe("inactive");
      expect(fake.notices).toEqual([]);
      await runtime.startAgent("agent-a", { ...config, provider: "pi" });
      await deliver(2);
      await fake.waitForNotices(2);
      await acks.done;
      expect(fake.notices).toHaveLength(2);
    });
    test("the fence trip's Activity is restated, at a higher clientSeq, on a kept delivery", async () => {
      const activities: import("@lrm/coforge-sdk/internal").AgentActivity[] = [];
      const { runtime, fake, deliver, rejections } = await deliveryGateHarness(
        "pi",
        undefined,
        undefined,
        (activity) => activities.push(activity),
      );
      try {
        for (let attempt = 0; attempt < 3; attempt++)
          fake.emit({ type: "error", message: "something odd happened" });
        await fake.disposed;
        await Bun.sleep(0);
        const fenced = activities.findLast((activity) => activity.detailKind === "runtime_error")!;
        expect(fenced.runtimeError?.errorReason).toBe("runtime_error_fenced");
        expect(fenced.detail).toBe(
          `Runtime stopped after 3 repeated runtime errors with the same fingerprint (${fenced.runtimeError?.fingerprint}). Last error: something odd happened Restart after the runtime/tooling issue is fixed.`,
        );
        const sentBefore = activities.length;
        await deliver(1);
        expect(rejections).toEqual([]);
        const restated = activities
          .slice(sentBefore)
          .find((activity) => activity.detailKind === "runtime_error");
        expect(restated?.runtimeError?.errorReason).toBe("runtime_error_fenced");
        expect(restated?.detail).toBe(fenced.detail);
        expect(restated?.clientSeq).toBeGreaterThan(fenced.clientSeq ?? 0);
      } finally {
        await runtime.stop();
      }
    });
    test("an explicit Stop discards the backoff and fence streaks for the next launch", async () => {
      const acks = ackGate(1);
      const { runtime, fake, deliver } = await deliveryGateHarness("pi", acks);
      jest.useFakeTimers();
      fake.emit({ type: "error", message: "connect ECONNRESET" });
      await deliver(1);
      await runtime.stopAgent("agent-a");
      await runtime.startAgent("agent-a", { ...config, provider: "pi" });
      await deliver(2);
      await fake.waitForNotices(1);
      await acks.done;
      expect(fake.notices).toHaveLength(1);
    });
    test(
      "a runtime stopped mid-backoff lets its process exit without waiting the backoff out",
      async () => {
        const startedAt = performance.now();
        const child = Bun.spawn(
          [
            process.execPath,
            new URL("./fixtures/stopped-runtime-exit.ts", import.meta.url).pathname,
          ],
          {
            cwd: new URL("..", import.meta.url).pathname,
            env: process.env,
            stdout: "ignore",
            stderr: "pipe",
          },
        );
        const exitCode = await child.exited;
        if (exitCode !== 0) throw new Error(await child.stderr.text());
        expect(performance.now() - startedAt).toBeLessThan(RUNTIME_ERROR_DELIVERY_BACKOFF_BASE_MS);
      },
      3 * RUNTIME_ERROR_DELIVERY_BACKOFF_BASE_MS,
    );
    test("a runtime started again after stopping mid-backoff delivers without waiting it out", async () => {
      const acks = ackGate(1);
      const { runtime, fake, deliver } = await deliveryGateHarness("pi", acks);
      jest.useFakeTimers();
      fake.emit({ type: "error", message: "connect ECONNRESET" });
      fake.emit({ type: "completed", status: "failed" });
      await runtime.stop();
      await runtime.start(connection);
      await runtime.startAgent("agent-a", { ...config, provider: "pi" });
      await deliver(2);
      await fake.waitForNotices(1);
      await acks.done;
      expect(fake.notices).toHaveLength(1);
    });
  });
  describe("activity probe with messages the Agent has not read", () => {
    afterEach(() => jest.useRealTimers());
    const probe = (runtime: DaemonRuntime, probeId: string) =>
      runtime.handleAgentActivityProbe({
        protocolMajor: 1,
        requestId: `request-${probeId}`,
        workspaceId: connection.workspaceId,
        computerId: connection.computerId,
        agentId: "agent-a",
        probeId,
      });
    async function idleWithUnreadMessage() {
      const acks = ackGate(1);
      const activities: import("@lrm/coforge-sdk/internal").AgentActivity[] = [];
      const harness = await deliveryGateHarness("pi", acks, undefined, (activity) =>
        activities.push(activity),
      );
      await harness.deliver(1);
      await acks.done;
      harness.fake.emit({ type: "completed", status: "completed" });
      expect(activities.at(-1)?.detailKind).toBe(AGENT_ACTIVITY_DETAIL_KIND.IDLE);
      return { ...harness, activities };
    }
    test("an idle Agent with an unread message answers Message received", async () => {
      const { runtime, activities } = await idleWithUnreadMessage();
      try {
        await probe(runtime, "probe-1");
        expect(activities.at(-1)).toMatchObject({
          agentId: "agent-a",
          detailKind: AGENT_ACTIVITY_DETAIL_KIND.MESSAGE_RECEIVED,
          level: "info",
          detail: "Message received",
          probeId: "probe-1",
          entries: [],
        });
      } finally {
        await runtime.stop();
      }
    });
    test("that answer is no busy evidence: no busy Agent is reported and no heartbeat follows", async () => {
      const { runtime, activities } = await idleWithUnreadMessage();
      jest.useFakeTimers();
      try {
        await probe(runtime, "probe-2");
        expect(activities.at(-1)?.detailKind).toBe(AGENT_ACTIVITY_DETAIL_KIND.MESSAGE_RECEIVED);
        const replied = activities.length;
        expect(runtime.holdRunners(RUNNER_HOLD_REASONS.WORKSPACE_RESTART)).toEqual([]);
        runtime.releaseRunners();
        jest.advanceTimersByTime(ACTIVITY_HEARTBEAT_MS * 2);
        expect(activities).toHaveLength(replied);
      } finally {
        await runtime.stop();
      }
    });
    test("once the message no longer waits, the probe answers idle again", async () => {
      const { runtime, activities } = await idleWithUnreadMessage();
      try {
        runtime.handleAgentInboxPurge({
          protocolMajor: 1,
          requestId: "purge-1",
          workspaceId: connection.workspaceId,
          computerId: connection.computerId,
          agentId: "agent-a",
          conversationIds: ["conversation-a"],
          targets: ["@ada"],
          reason: "member_removed",
        });
        await probe(runtime, "probe-3");
        expect(activities.at(-1)).toMatchObject({
          detailKind: AGENT_ACTIVITY_DETAIL_KIND.IDLE,
          probeId: "probe-3",
        });
      } finally {
        await runtime.stop();
      }
    });
    test("an Agent the fingerprint fence took offline keeps deliveries and stays quiet to a probe", async () => {
      const activities: import("@lrm/coforge-sdk/internal").AgentActivity[] = [];
      const { runtime, fake, deliver, rejections } = await deliveryGateHarness(
        "pi",
        undefined,
        undefined,
        (activity) => activities.push(activity),
      );
      try {
        for (let failure = 0; failure < 3; failure++)
          fake.emit({ type: "error", message: "HTTP 403" });
        await fake.disposed;
        await Bun.sleep(0);
        await deliver(1);
        expect(rejections).toEqual([]);
        await probe(runtime, "probe-4");
        expect(activities.filter((activity) => activity.probeId === "probe-4")).toEqual([]);
      } finally {
        await runtime.stop();
      }
    });
    test.each([
      [
        "a runtime error backoff",
        "connect ECONNRESET",
        1,
        AGENT_ACTIVITY_DETAIL_KIND.MESSAGE_RECEIVED,
      ],
      [
        "a rate limit backoff",
        "429 Too Many Requests",
        1,
        AGENT_ACTIVITY_DETAIL_KIND.MESSAGE_RECEIVED,
      ],
    ] as const)("a message held behind %s", async (_hold, message, failures, expected) => {
      const acks = ackGate(1);
      const activities: import("@lrm/coforge-sdk/internal").AgentActivity[] = [];
      const { runtime, fake, deliver } = await deliveryGateHarness(
        "pi",
        acks,
        undefined,
        (activity) => activities.push(activity),
      );
      jest.useFakeTimers();
      try {
        for (let failure = 0; failure < failures; failure++) fake.emit({ type: "error", message });
        fake.emit({ type: "completed", status: "failed" });
        await deliver(1);
        await acks.done;
        expect(fake.notices).toEqual([]);
        await probe(runtime, "probe-4");
        expect(activities.at(-1)).toMatchObject({
          agentId: "agent-a",
          detailKind: expected,
          level: "info",
          probeId: "probe-4",
        });
      } finally {
        await runtime.stop();
      }
    });
    test("unread wins over a remembered busy turn, whose heartbeat stays armed", async () => {
      const acks = ackGate(1);
      const activities: import("@lrm/coforge-sdk/internal").AgentActivity[] = [];
      const { runtime, fake, deliver } = await deliveryGateHarness(
        "pi",
        acks,
        undefined,
        (activity) => activities.push(activity),
      );
      jest.useFakeTimers();
      try {
        await deliver(1);
        await acks.done;
        fake.emit({
          type: "activity",
          activity: {
            detailKind: AGENT_ACTIVITY_DETAIL_KIND.TOOL_STARTED,
            level: "info",
            detail: "Read",
            observedAtMs: Date.now(),
          },
        });
        expect(runtime.busyAgents()).toMatchObject([
          { agentId: "agent-a", detailKind: AGENT_ACTIVITY_DETAIL_KIND.TOOL_STARTED },
        ]);
        await probe(runtime, "probe-5");
        expect(activities.at(-1)).toMatchObject({
          detailKind: AGENT_ACTIVITY_DETAIL_KIND.MESSAGE_RECEIVED,
          probeId: "probe-5",
        });
        expect(runtime.busyAgents()).toMatchObject([
          { agentId: "agent-a", detailKind: AGENT_ACTIVITY_DETAIL_KIND.TOOL_STARTED },
        ]);
        const replied = activities.length;
        jest.advanceTimersByTime(ACTIVITY_HEARTBEAT_MS);
        expect(activities).toHaveLength(replied + 1);
        expect(activities.at(-1)).toMatchObject({
          detailKind: AGENT_ACTIVITY_DETAIL_KIND.TOOL_STARTED,
          isHeartbeat: true,
        });
        expect(activities.at(-1)?.probeId).toBeUndefined();
      } finally {
        await runtime.stop();
      }
    });
  });
});
function connectedClient(): CentrifugeWorkspaceClient {
  let connected: (() => void) | undefined;
  return {
    on(event, callback) {
      if (event === "connected") connected = callback as () => void;
    },
    connect() {
      connected?.();
    },
    disconnect() {},
    async rpc() {},
  };
}
function runtimeOver(
  credentials: InMemoryDaemonCredentialStore,
  client: CentrifugeWorkspaceClient,
) {
  return new DaemonRuntime(
    connection,
    () => ({ provider: "pi", createAgentSession: async () => sessionSpy() }),
    credentials,
    { create: () => new DaemonConnection("wss://cloud.example", () => client) },
    undefined,
    emptyCodeAgentDiscovery,
    workspaceRoot,
  );
}
function retryingRuntime(token: string) {
  const attempted = Promise.withResolvers<void>();
  let connectErrors: ((error: unknown) => void) | undefined;
  const retryingClient: CentrifugeWorkspaceClient = {
    on(event, callback) {
      if (event === "error") connectErrors = callback as (error: unknown) => void;
    },
    connect() {
      connectErrors?.({ type: "transport", error: { code: 2, message: "transport closed" } });
      attempted.resolve();
    },
    disconnect() {},
    async rpc() {},
  };
  const credentials = new InMemoryDaemonCredentialStore();
  return {
    runtime: runtimeOver(credentials, retryingClient),
    attempted: attempted.promise,
    saveCredential: () => credentials.save(connection.workspaceId, connection.computerId, token),
  };
}
test("stopping a runtime whose first cloud connect is still retrying ends its start", async () => {
  const { runtime, attempted, saveCredential } = retryingRuntime("token-retrying");
  await saveCredential();
  const start = runtime.start(connection).catch((error: unknown) => error);
  await attempted;
  await runtime.stop();
  expect(await start).toBeInstanceOf(DaemonConnectionStoppedError);
});
test("a stop that arrives before the first cloud connect begins still ends it", async () => {
  const { runtime, saveCredential } = retryingRuntime("token-stopped-early");
  await saveCredential();
  const start = runtime.start(connection).catch((error: unknown) => error);
  await runtime.stop();
  expect(await start).toBeInstanceOf(DaemonConnectionStoppedError);
});
test("stopping a runtime whose first ready keeps failing ends its start", async () => {
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-ready-failing");
  const readyAttempted = Promise.withResolvers<void>();
  const client: CentrifugeWorkspaceClient = {
    ...connectedClient(),
    async rpc(method) {
      if (method !== DAEMON_RUNTIME_READY_METHOD) return new Uint8Array();
      readyAttempted.resolve();
      throw Object.assign(new Error("daemon ready failed"), { code: 503 });
    },
  };
  const runtime = runtimeOver(credentials, client);
  const start = runtime.start(connection).catch((error: unknown) => error);
  await readyAttempted.promise;
  await runtime.stop();
  expect(await start).toBeInstanceOf(DaemonConnectionStoppedError);
});
test("a start that fails after connecting stops that connection instead of leaving it online", async () => {
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-start-fails");
  const calls: string[] = [];
  const runtime = new DaemonRuntime(
    connection,
    () => ({ provider: "pi", createAgentSession: async () => sessionSpy() }),
    credentials,
    {
      create: () => ({
        async start() {
          calls.push("start");
        },
        async ready() {
          calls.push("ready");
          throw new Error("ready failed");
        },
        async stop() {
          calls.push("stop");
        },
      }),
    },
    undefined,
    emptyCodeAgentDiscovery,
    workspaceRoot,
  );
  await expect(runtime.start(connection)).rejects.toThrow("ready failed");
  expect(calls).toEqual(["start", "ready", "stop"]);
});
test("a local hold persists until an explicit read", async () => {
  const calls: AgentMessageRequest[] = [];
  const harness = await messageHarness(async (request) => {
    calls.push(request);
    return {
      protocolMajor: 1,
      idempotencyKey: request.idempotencyKey,
      accepted: true,
      attentionCount: 0,
      messages: [],
      messageId: "sent",
      state: "sent",
      decision: "forward",
    };
  });
  try {
    await harness.deliver(1, "#general");
    const send = {
      idempotencyKey: "send-held-1",
      context: harness.context,
      operation: "send" as const,
      target: "#general",
      content: "reply",
    };
    const held = await harness.runtime.agentMessage(harness.context, send, harness.apiKey);
    expect(held.state).toBe("held");
    expect(held.decision).toBe("local_hold");
    expect(held.reason).toBe("exact_target_pending");
    expect(held.newMessageCount).toBe(1);
    expect(held.messages.map((message) => message.sequence)).toEqual([1]);
    expect(held.messageId).toBe("");
    expect(calls.filter((call) => call.operation === "send")).toHaveLength(0);
    const resent = await harness.runtime.agentMessage(
      harness.context,
      { ...send, idempotencyKey: "send-held-2", sendDraft: true },
      harness.apiKey,
    );
    expect(resent.state).toBe("held");
    expect(calls.filter((call) => call.operation === "send")).toHaveLength(0);
  } finally {
    await harness.runtime.stop();
  }
});
test("a held send reports the freshness-decision activity and fact id", async () => {
  const stateDirectory = join(tempRoot, `coforge-freshness-activity-${crypto.randomUUID()}`);
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");
  const activities: import("@lrm/coforge-sdk/internal").AgentActivity[] = [];
  const runtime = new DaemonRuntime(
    connection,
    () => ({
      provider: "pi",
      createAgentSession: async () => ({ ...sessionSpy(), async notify() {} }),
    }),
    credentials,
    {
      create: () => ({
        async start() {},
        async ready() {},
        async stop() {},
        async requestAgentLaunchConfig() {
          return agentLaunchConfig(`sk_agent_${"a".repeat(43)}`);
        },
        async revokeAgentApiKey() {},
        sendAgentActivity(activity) {
          activities.push(activity);
        },
        async agentMessage() {
          throw new Error("the daemon must hold this send locally");
        },
      }),
    },
    undefined,
    emptyCodeAgentDiscovery,
    stateDirectory,
  );
  try {
    await runtime.start(connection);
    await runtime.handleAgentStart({
      protocolMajor: 1,
      requestId: "start-freshness-activity",
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      agentId: "agent-a",
      ...config,
      controlEpoch: 1,
      launchId: "launch-freshness-activity",
    });
    const context = runtime.issueAgentContext("agent-a");
    await runtime.handleAgentMessage({
      protocolMajor: 1,
      requestId: "delivery-freshness-activity",
      messageId: "message-1",
      deliveryId: "delivery-1",
      sequence: 1,
      workspaceId: connection.workspaceId,
      conversationId: "conversation-a",
      agentId: "agent-a",
      body: "newer context",
      method: "agent:v1:message:deliver",
      target: "#general",
    });
    activities.length = 0;
    const held = await runtime.agentMessage(
      context,
      {
        idempotencyKey: "send-freshness-activity",
        context,
        operation: "send",
        target: "#general",
        content: "reply",
      },
      `sk_agent_${"a".repeat(43)}`,
    );
    expect(held).toMatchObject({ state: "held", decision: "local_hold" });
    const frame = activities.find((activity) => activity.detailKind === "freshness_hold");
    expect(frame).toMatchObject({
      detail: "Send held by freshness check",
      activityKind: "working",
      entries: [
        {
          kind: "system",
          title: "Send held by freshness check",
          text: [
            "target: #general",
            "new messages: 1 newer message",
            "decision: local hold; review the newer context before retrying",
          ].join("\n"),
        },
      ],
    });
    expect(frame?.producerFactId).toMatch(/^freshness_decision_fact:[0-9a-f]{64}$/);
  } finally {
    await runtime.stop();
    await rm(stateDirectory, { recursive: true, force: true });
  }
});
test("--send-draft --anyway bypasses the daemon's own hold and reaches the transport", async () => {
  const calls: AgentMessageRequest[] = [];
  const harness = await messageHarness(async (request) => {
    calls.push(request);
    return {
      protocolMajor: 1,
      idempotencyKey: request.idempotencyKey,
      accepted: true,
      attentionCount: 0,
      messages: [],
      messageId: "sent",
      state: "sent",
      decision: "forward",
    };
  });
  try {
    await harness.deliver(3, "#general");
    const sent = await harness.runtime.agentMessage(
      harness.context,
      {
        idempotencyKey: "send-anyway-1",
        context: harness.context,
        operation: "send",
        target: "#general",
        content: "reply anyway",
        continueAnyway: true,
      },
      harness.apiKey,
    );
    expect(sent.state).toBe("sent");
    const sends = calls.filter((call) => call.operation === "send");
    expect(sends).toHaveLength(1);
    expect(sends[0]?.continueAnyway).toBe(true);
    expect(sent.state).toBe("sent");
  } finally {
    await harness.runtime.stop();
  }
});
test("a resend can explicitly bypass a local hold", async () => {
  const calls: AgentMessageRequest[] = [];
  const harness = await messageHarness(async (request) => {
    calls.push(request);
    return {
      protocolMajor: 1,
      idempotencyKey: request.idempotencyKey,
      accepted: true,
      attentionCount: 0,
      messages: [],
      messageId: "sent",
      state: "sent",
      decision: "forward",
    };
  });
  try {
    await harness.deliver(1, "#general");
    await harness.deliver(2, "#general");
    const send = {
      idempotencyKey: "send-window-1",
      context: harness.context,
      operation: "send" as const,
      target: "#general",
      content: "reply",
    };
    const held = await harness.runtime.agentMessage(harness.context, send, harness.apiKey);
    expect(held.state).toBe("held");
    expect(held.newMessageCount).toBe(2);
    expect(held.messages.map((message) => message.sequence)).toEqual([1, 2]);
    expect(calls.filter((call) => call.operation === "send")).toHaveLength(0);
    const resent = await harness.runtime.agentMessage(
      harness.context,
      { ...send, idempotencyKey: "send-window-2", sendDraft: true, continueAnyway: true },
      harness.apiKey,
    );
    expect(resent.state).toBe("sent");
    expect(calls.filter((call) => call.operation === "send")).toHaveLength(1);
  } finally {
    await harness.runtime.stop();
  }
});
test("a genuinely new send still replaces the target's draft", async () => {
  const calls: AgentMessageRequest[] = [];
  const harness = await messageHarness(async (request) => {
    calls.push(request);
    return !request.sendDraft
      ? {
          protocolMajor: 1,
          idempotencyKey: request.idempotencyKey,
          accepted: false,
          attentionCount: 1,
          state: "held" as const,
          decision: "local_hold" as const,
          reason: "exact_target_pending",
          continueAnywaySuggested: true,
          newMessageCount: 1,
          shownMessageCount: 1,
          omittedMessageCount: 0,
          seenUpToSeq: 7,
          messages: [],
        }
      : {
          protocolMajor: 1,
          idempotencyKey: request.idempotencyKey,
          accepted: true,
          attentionCount: 0,
          state: "sent" as const,
          decision: "forward" as const,
          messageId: "sent",
          messages: [],
        };
  });
  try {
    await harness.runtime.agentMessage(
      harness.context,
      {
        idempotencyKey: "send-held",
        context: harness.context,
        operation: "send",
        target: "@ada",
        content: "held body",
      },
      harness.apiKey,
    );
    await harness.runtime.agentMessage(
      harness.context,
      {
        idempotencyKey: "send-new",
        context: harness.context,
        operation: "send",
        target: "@ada",
        content: "newer body",
      },
      harness.apiKey,
    );
    const resent = await harness.runtime.agentMessage(
      harness.context,
      {
        idempotencyKey: "send-resend",
        context: harness.context,
        operation: "send",
        target: "@ada",
        sendDraft: true,
      },
      harness.apiKey,
    );
    expect(resent.state).toBe("sent");
    expect(
      calls
        .filter((call) => call.operation === "send")
        .map((call) => call.content)
        .at(-1),
    ).toBe("newer body");
  } finally {
    await harness.runtime.stop();
  }
});
describe("one logical send keeps one idempotency key", () => {
  const sent = (
    request: Pick<AgentMessageRequest, "idempotencyKey">,
    messageId = "sent",
  ): AgentMessageTransportResponse => ({
    idempotencyKey: request.idempotencyKey,
    accepted: true,
    attentionCount: 0,
    messageId,
    messages: [],
    state: "sent",
    decision: "forward",
  });
  const held = (request: AgentMessageRequest): AgentMessageTransportResponse => ({
    idempotencyKey: request.idempotencyKey,
    accepted: false,
    attentionCount: 1,
    state: "held",
    decision: "local_hold",
    reason: "exact_target_pending",
    newMessageCount: 1,
    shownMessageCount: 0,
    omittedMessageCount: 0,
    seenUpToSeq: 7,
    messages: [],
  });
  const notFound = async (
    request: AgentSendReconciliationRequest,
  ): Promise<AgentSendReconciliationResponse> => ({
    idempotencyKey: request.idempotencyKey,
    state: "not_found",
    reconciliation: true,
  });
  const lostBeforeResponse = () =>
    AgentTransportError.preResponseTransport("agent send", new Error("socket closed"));
  const lostMidResponse = () =>
    AgentTransportError.midResponseTransport("agent send", 200, new Error("stream reset"));
  const draft = async (stateDirectory: string) => {
    const lookup = await new AgentMessageDraftStore(
      AgentStateDb.open(stateDirectory, "agent-a"),
    ).lookup("@ada");
    return lookup.status === "found" ? lookup.draft : undefined;
  };
  const deferred = <T>() => {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
  type Harness = Awaited<ReturnType<typeof messageHarness>>;
  const send = (
    harness: Harness,
    idempotencyKey: string,
    fields: Partial<import("@lrm/coforge-sdk/internal").LocalAgentMessageRequest> = {},
  ) =>
    harness.runtime.agentMessage(
      harness.context,
      {
        idempotencyKey,
        context: harness.context,
        operation: "send",
        target: "@ada",
        ...fields,
      },
      harness.apiKey,
    );
  const failure = (promise: Promise<unknown>) =>
    promise.then(
      () => undefined,
      (error) => error,
    );
  const harnessWith = (
    respond: (request: AgentMessageRequest) => Promise<AgentMessageTransportResponse>,
    reconcile?: (
      request: AgentSendReconciliationRequest,
    ) => Promise<AgentSendReconciliationResponse>,
    stateDirectory?: string,
  ) => messageHarness(respond, undefined, undefined, undefined, reconcile, stateDirectory);
  test("--send-draft after an unknown outcome sends under the original send's key, then clears", async () => {
    const calls: AgentMessageRequest[] = [];
    const harness = await harnessWith(async (request) => {
      calls.push(request);
      if (calls.length === 1) throw lostMidResponse();
      return sent(request);
    });
    try {
      expect(await failure(send(harness, "send-first", { content: "reply" }))).toBeInstanceOf(
        AgentTransportError,
      );
      expect((await draft(harness.stateDirectory))?.idempotencyKey).toBe("send-first");
      const resent = await send(harness, "send-again", { sendDraft: true });
      expect(resent.state).toBe("sent");
      expect(calls.map((call) => [call.idempotencyKey, call.content])).toEqual([
        ["send-first", "reply"],
        ["send-first", "reply"],
      ]);
      expect(await draft(harness.stateDirectory)).toBeUndefined();
    } finally {
      await harness.runtime.stop();
    }
  });
  test("a held refresh keeps the draft's key, so the resend is the same logical send", async () => {
    const calls: AgentMessageRequest[] = [];
    const harness = await harnessWith(async (request) => {
      calls.push(request);
      return request.sendDraft ? sent(request) : held(request);
    });
    try {
      expect((await send(harness, "send-held", { content: "held reply" })).state).toBe("held");
      expect(await draft(harness.stateDirectory)).toMatchObject({
        idempotencyKey: "send-held",
        reholdCount: 1,
      });
      await send(harness, "send-resend", { sendDraft: true });
      expect(calls.map((call) => call.idempotencyKey)).toEqual(["send-held", "send-held"]);
    } finally {
      await harness.runtime.stop();
    }
  });
  test("an accepted send whose key differs from the draft's leaves the newer draft in place", async () => {
    const answer = deferred<AgentMessageTransportResponse>();
    const issued = deferred<void>();
    const harness = await harnessWith(async (request) => {
      if (request.content === "newer reply") return held(request);
      issued.resolve();
      return answer.promise;
    });
    try {
      const older = send(harness, "send-older", { content: "older reply" });
      await issued.promise;
      await send(harness, "send-newer", { content: "newer reply" });
      answer.resolve(sent({ idempotencyKey: "send-older" }));
      expect((await older).state).toBe("sent");
      expect(await draft(harness.stateDirectory)).toMatchObject({
        content: "newer reply",
        idempotencyKey: "send-newer",
      });
    } finally {
      await harness.runtime.stop();
    }
  });
  test("--expected-draft-key refuses a draft that now belongs to another send, without a request", async () => {
    const calls: AgentMessageRequest[] = [];
    const harness = await harnessWith(async (request) => {
      calls.push(request);
      return held(request);
    });
    try {
      await send(harness, "send-newer", { content: "newer draft" });
      calls.length = 0;
      const refused = await failure(
        send(harness, "send-check", { sendDraft: true, expectedDraftKey: "send-older" }),
      );
      expect(refused).toBeInstanceOf(AgentPreflightError);
      expect(refused).toMatchObject({
        code: "SAVED_DRAFT_IDENTITY_CHANGED",
        verdict: { draftSaved: false, retryable: false },
      });
      expect((refused as AgentPreflightError).verdict.suggestedNextAction).toContain(
        "Review the current draft",
      );
      expect(calls).toEqual([]);
      expect(await draft(harness.stateDirectory)).toMatchObject({
        content: "newer draft",
        idempotencyKey: "send-newer",
      });
    } finally {
      await harness.runtime.stop();
    }
  });
  test("an expired draft is not sent: the entry is removed and its body travels once, as details", async () => {
    const calls: AgentMessageRequest[] = [];
    const stateDirectory = join(tempRoot, `coforge-stale-${crypto.randomUUID()}`);
    const savedAt = Date.now() - AGENT_MESSAGE_DRAFT_TTL_MS - 1000;
    await new AgentMessageDraftStore(
      AgentStateDb.open(stateDirectory, "agent-a"),
      () => savedAt,
    ).save("@ada", {
      content: "stale reply\n",
      idempotencyKey: "send-stale",
    });
    const harness = await harnessWith(
      async (request) => {
        calls.push(request);
        return sent(request);
      },
      undefined,
      stateDirectory,
    );
    try {
      const expired = await failure(send(harness, "send-late", { sendDraft: true }));
      expect(expired).toBeInstanceOf(AgentPreflightError);
      const error = expired as AgentPreflightError;
      expect(error.code).toBe("SEND_DRAFT_EXPIRED");
      expect(error.message).toContain("This command did not send anything.");
      expect(error.message).not.toContain("stale reply");
      expect(error.verdict.suggestedNextAction).toContain("may already have been delivered");
      expect(error.details).toEqual({
        discarded_draft: { content: "stale reply\n", saved_at: new Date(savedAt).toISOString() },
      });
      expect(calls).toEqual([]);
      expect(await failure(send(harness, "send-later", { sendDraft: true }))).toMatchObject({
        code: "SEND_DRAFT_NOT_FOUND",
      });
    } finally {
      await harness.runtime.stop();
    }
  });
  test("a send to another target never drops this target's expired draft or its last copy", async () => {
    const stateDirectory = join(tempRoot, `coforge-other-${crypto.randomUUID()}`);
    const savedAt = Date.now() - AGENT_MESSAGE_DRAFT_TTL_MS - 1000;
    await new AgentMessageDraftStore(
      AgentStateDb.open(stateDirectory, "agent-a"),
      () => savedAt,
    ).save("@ada", {
      content: "ada's reply",
      idempotencyKey: "send-ada",
    });
    const harness = await harnessWith(async (request) => sent(request), undefined, stateDirectory);
    try {
      await send(harness, "send-bob", { target: "@bob", content: "bob's reply" });
      const expired = await failure(send(harness, "send-late", { sendDraft: true }));
      expect(expired).toMatchObject({
        code: "SEND_DRAFT_EXPIRED",
        details: { discarded_draft: { content: "ada's reply" } },
      });
    } finally {
      await harness.runtime.stop();
    }
  });
  test("the send's log names the key it actually went out under, and so does its answer", async () => {
    const harness = await harnessWith(async (request) =>
      request.sendDraft ? sent(request) : held(request),
    );
    try {
      await send(harness, "send-held", { content: "held reply" });
      const { result, records } = await captureDaemonLogs(() =>
        send(harness, "send-resend", { sendDraft: true }),
      );
      expect(result.idempotencyKey).toBe("send-held");
      const sentRecord = records.find((record) => record.properties.event === "agent.message.sent");
      expect(sentRecord?.properties.request_id).toBe("send-held");
    } finally {
      await harness.runtime.stop();
    }
  });
  test("a draft written without a key is no draft to resend", async () => {
    const stateDirectory = join(tempRoot, `coforge-keyless-${crypto.randomUUID()}`);
    await new AgentMessageDraftStore(AgentStateDb.open(stateDirectory, "agent-a")).save("@ada", {
      content: "keyless",
      idempotencyKey: "",
    });
    const calls: AgentMessageRequest[] = [];
    const harness = await harnessWith(
      async (request) => {
        calls.push(request);
        return sent(request);
      },
      undefined,
      stateDirectory,
    );
    try {
      expect(await failure(send(harness, "send-draft", { sendDraft: true }))).toMatchObject({
        code: "SEND_DRAFT_NOT_FOUND",
      });
      expect(calls).toEqual([]);
    } finally {
      await harness.runtime.stop();
    }
  });
  test("the draft's key outlives a daemon restart", async () => {
    const stateDirectory = join(tempRoot, `coforge-restart-${crypto.randomUUID()}`);
    const first = await harnessWith(async (request) => held(request), undefined, stateDirectory);
    await send(first, "send-held", { content: "held reply" });
    await first.runtime.stop();
    const calls: AgentMessageRequest[] = [];
    const second = await harnessWith(
      async (request) => {
        calls.push(request);
        return sent(request);
      },
      undefined,
      stateDirectory,
    );
    try {
      expect(
        await failure(send(second, "send-a", { sendDraft: true, expectedDraftKey: "send-older" })),
      ).toMatchObject({ code: "SAVED_DRAFT_IDENTITY_CHANGED" });
      expect(calls).toEqual([]);
      await send(second, "send-b", { sendDraft: true, expectedDraftKey: "send-held" });
      expect(calls.map((call) => [call.idempotencyKey, call.content])).toEqual([
        ["send-held", "held reply"],
      ]);
      expect(await draft(stateDirectory)).toBeUndefined();
    } finally {
      await second.runtime.stop();
    }
  });
  describe("settling an ambiguous send through the runtime (cases in agent-send-settlement.test.ts)", () => {
    test("a lost response reconciled as committed is the send's success and consumes its draft", async () => {
      const reconciled: AgentSendReconciliationRequest[] = [];
      const harness = await harnessWith(
        async () => {
          throw lostBeforeResponse();
        },
        async (request) => {
          reconciled.push(request);
          return {
            idempotencyKey: request.idempotencyKey,
            state: "committed",
            reconciliation: true,
            receiptComplete: false,
            messageId: "committed-1",
          };
        },
      );
      try {
        const { result, records } = await captureDaemonLogs(() =>
          send(harness, "send-lost", { content: "reply" }),
        );
        expect(result).toMatchObject({
          accepted: true,
          state: "committed",
          messageId: "committed-1",
        });
        const reconciledLog = records.find(
          (record) => record.properties.event === "agent.message.send_reconciled",
        )?.properties;
        expect(reconciledLog).toMatchObject({
          request_id: "send-lost",
          outcome: "ok",
          reconciliation: "committed",
        });
        const sentLog = records.find(
          (record) => record.properties.event === "agent.message.sent",
        )?.properties;
        expect(sentLog?.outcome).toBe("ok");
        expect(sentLog).not.toHaveProperty("freshness_decision", "reconciled");
        expect(reconciled).toEqual([
          {
            idempotencyKey: "send-lost",
            agentId: "agent-a",
            workspaceId: connection.workspaceId,
            target: "@ada",
          },
        ]);
        expect(await draft(harness.stateDirectory)).toBeUndefined();
      } finally {
        await harness.runtime.stop();
      }
    });
    test("a send's worst case stays within the CLI's budget of daemon requests", async () => {
      const rootId = "12345678-1234-4234-8234-123456789abc";
      let requests = 0;
      const harness = await harnessWith(
        async (request) => {
          requests += 1;
          if (request.operation === "read")
            return {
              idempotencyKey: request.idempotencyKey,
              accepted: true,
              attentionCount: 0,
              messages: [messageRecord(1, "@ada", "@ada", rootId)],
            };
          throw lostBeforeResponse();
        },
        async (request) => {
          requests += 1;
          return notFound(request);
        },
      );
      try {
        await failure(send(harness, "send-thread", { target: "@ada:12345678", content: "reply" }));
        expect(requests).toBe(AGENT_SEND_MAX_REQUESTS);
        expect(AGENT_SEND_LOCAL_DEADLINE_MS).toBeGreaterThan(
          AGENT_SEND_MAX_REQUESTS * AGENT_SEND_REQUEST_TIMEOUT_MS,
        );
      } finally {
        await harness.runtime.stop();
      }
    });
    test("a failed replay is retryable while the runtime's draft still holds the key", async () => {
      const harness = await harnessWith(async () => {
        throw lostBeforeResponse();
      }, notFound);
      try {
        const error = await failure(send(harness, "send-replay", { content: "reply" }));
        expect(error).toBeInstanceOf(AgentSendVerdictError);
        expect((error as AgentSendVerdictError).verdict).toMatchObject({
          retryable: true,
          draftSaved: true,
        });
        expect((error as AgentSendVerdictError).verdict.suggestedNextAction).toContain(
          '--expected-draft-key "send-replay" --target "@ada"',
        );
        expect((await draft(harness.stateDirectory))?.idempotencyKey).toBe("send-replay");
      } finally {
        await harness.runtime.stop();
      }
    });
    test("a failed replay whose draft another send took over is not retryable", async () => {
      const replay = deferred<AgentMessageTransportResponse>();
      const replayIssued = deferred<void>();
      let lost = false;
      const harness = await harnessWith(async (request) => {
        if (request.content === "newer reply") return held(request);
        if (!lost) {
          lost = true;
          throw lostBeforeResponse();
        }
        replayIssued.resolve();
        return replay.promise;
      }, notFound);
      try {
        const older = failure(send(harness, "send-older", { content: "older reply" }));
        await replayIssued.promise;
        expect((await send(harness, "send-newer", { content: "newer reply" })).state).toBe("held");
        replay.reject(lostBeforeResponse());
        const error = (await older) as AgentSendVerdictError;
        expect(error).toBeInstanceOf(AgentSendVerdictError);
        expect(error.verdict).toMatchObject({ retryable: false, draftSaved: false });
        expect(error.verdict.suggestedNextAction).toContain("CANNOT_CONFIRM");
        expect(await draft(harness.stateDirectory)).toMatchObject({
          content: "newer reply",
          idempotencyKey: "send-newer",
        });
      } finally {
        await harness.runtime.stop();
      }
    });
  });
});
describe("a launch that cannot start says why", () => {
  async function failedLaunch(
    fail: {
      session?: () => unknown;
      credential?: () => unknown;
    },
    agentConfig: AgentRuntimeConfig = config,
  ) {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(connection.workspaceId, connection.computerId, "token-a");
    const activities: import("@lrm/coforge-sdk/internal").AgentActivity[] = [];
    const runtime = new DaemonRuntime(
      connection,
      () => ({
        provider: agentConfig.provider,
        async createAgentSession() {
          if (fail.session) throw fail.session();
          return sessionSpy();
        },
      }),
      credentials,
      {
        create: () => ({
          async start() {},
          async ready() {},
          async stop() {},
          sendAgentActivity(activity) {
            activities.push(activity);
          },
          async requestAgentLaunchConfig() {
            if (fail.credential) throw fail.credential();
            return agentLaunchConfig(`sk_agent_${"a".repeat(43)}`);
          },
          async revokeAgentApiKey() {},
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
    );
    try {
      await runtime.start(connection);
      await expect(runtime.startAgent("agent-a", agentConfig)).rejects.toBeDefined();
      return activities.at(-1);
    } finally {
      await runtime.stop();
    }
  }
  const logsNextStep = " See `coforge-computer logs` for the cause, then start the Agent again.";
  test("a runtime executable the spawner cannot find is reported as runtime_not_found", async () => {
    const activity = await failedLaunch(
      { session: () => new RuntimeExecutableNotFoundError("codex") },
      { ...config, provider: "codex", model: "gpt-5.5", modelProvider: undefined },
    );
    expect(activity).toMatchObject({
      detailKind: "runtime_error",
      level: "error",
      detail:
        "Codex is not installed on this Computer, or it is not on the PATH the Computer starts " +
        "Agents with. Install Codex, then start the Agent again.",
      runtimeError: { errorClass: "LauncherError", errorReason: "runtime_not_found" },
    });
  });
  test("any other ENOENT during launch is runtime_spawn_failed, not a missing runtime", async () => {
    const activity = await failedLaunch({
      session: () =>
        Object.assign(new Error("ENOENT: no such file or directory, open 'MEMORY.md'"), {
          code: "ENOENT",
        }),
    });
    expect(activity).toMatchObject({
      detail: `Agent runtime could not be started.${logsNextStep}`,
      runtimeError: { errorClass: "LauncherError", errorReason: "runtime_spawn_failed" },
    });
  });
  test("a model the runtime does not offer is reported as model_not_found, naming it", async () => {
    const activity = await failedLaunch({
      session: () => new RuntimeModelNotFoundError("claude-9"),
    });
    expect(activity).toMatchObject({
      detailKind: "runtime_error",
      detail:
        "Model claude-9 is not available to Pi on this Computer. Choose another model in the " +
        "Agent's settings, then start it again.",
      runtimeError: { errorClass: "LauncherError", errorReason: "model_not_found" },
    });
  });
  test("a model provider setting the runtime cannot use is model_provider_not_configured", async () => {
    const activity = await failedLaunch({
      session: () =>
        new ModelProviderSettingError("Pi runtime provider does not match the selected model"),
    });
    expect(activity).toMatchObject({
      detailKind: "runtime_error",
      detail:
        "Pi cannot use the Agent's model provider setting. Configure the model provider in the " +
        "Agent's settings, then start it again.",
      runtimeError: { errorClass: "LauncherError", errorReason: "model_provider_not_configured" },
    });
  });
  test("an Agent environment variable the runtime cannot use is agent_environment_invalid, naming it", async () => {
    const cause = "NODE_EXTRA_CA_CERTS names /missing/ca.pem, which could not be read: ENOENT";
    const activity = await failedLaunch({ session: () => new AgentEnvironmentError(cause) });
    expect(activity).toMatchObject({
      detailKind: "runtime_error",
      detail: `${cause}. Correct it in the Agent's environment variables, then start the Agent again.`,
      runtimeError: { errorClass: "LauncherError", errorReason: "agent_environment_invalid" },
    });
  });
  test("a runtime CLI below the supported version is reported as runtime_version_too_old", async () => {
    const refusal =
      "Kiro CLI 2.16.0 is unsupported; requires Kiro CLI >= 2.21.2. Upgrade kiro-cli before starting this runtime.";
    const activity = await failedLaunch(
      { session: () => new RuntimeVersionUnsupportedError(refusal) },
      { ...config, provider: "kiro", model: "auto", modelProvider: undefined },
    );
    expect(activity).toMatchObject({
      detailKind: "runtime_error",
      detail: refusal,
      runtimeError: { errorClass: "LauncherError", errorReason: "runtime_version_too_old" },
    });
  });
  test("a launch the server does not authorize is reported as agent_authorization_failed", async () => {
    const activity = await failedLaunch({
      credential: () => new Error("Agent launch config request failed (403)"),
    });
    expect(activity).toMatchObject({
      detailKind: "runtime_error",
      detail:
        "Agent authorization could not be prepared: this Computer could not obtain the Agent's " +
        "launch credentials from the server. Check the Workspace connection with " +
        "`coforge-computer status`, then start the Agent again.",
      runtimeError: { errorClass: "LauncherError", errorReason: "agent_authorization_failed" },
    });
  });
  test("every failed launch, woken or managed, is logged with its reason and cause", async () => {
    const { records } = await captureDaemonLogs(() =>
      failedLaunch({ session: () => new RuntimeModelNotFoundError("claude-9") }),
    );
    const failure = records.find(
      (record) => record.properties.event === "agent_runtime:launch_failed",
    );
    expect(failure?.properties).toMatchObject({
      agent_id: "agent-a",
      provider: "pi",
      failure_reason: "model_not_found",
      error_message: "Model claude-9 is not available to this runtime",
    });
  });
  test("a message that merely mentions a missing model is not classified as model_not_found", async () => {
    const activity = await failedLaunch({ session: () => new Error("model claude-9 not found") });
    expect(activity).toMatchObject({
      detail: `Agent runtime could not be started.${logsNextStep}`,
      runtimeError: { errorClass: "LauncherError", errorReason: "runtime_spawn_failed" },
    });
  });
});
test("a daemon that can migrate says so in its ready, and starts no Agent a source migration holds", async () => {
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-migration");
  let snapshot: (() => import("@lrm/coforge-sdk/internal").DaemonRuntimeReadyRequest) | undefined;
  let lease: ((lease: ReceivedAgentMigrationLease) => void) | undefined;
  const runtime = new DaemonRuntime(
    connection,
    () => ({ provider: "pi", createAgentSession: async () => sessionSpy() }),
    credentials,
    {
      create: () => ({
        async start() {},
        async stop() {},
        async ready(get) {
          snapshot = get;
        },
        onAgentMigrationLease(callback) {
          lease = callback;
          return () => {};
        },
        agentMigrationServer: () =>
          ({
            view: (_id: string, signal: AbortSignal) =>
              new Promise((_resolve, reject) =>
                signal.addEventListener("abort", () => reject(signal.reason)),
              ),
          }) as unknown as AgentMigrationServer,
      }),
    },
    undefined,
    emptyCodeAgentDiscovery,
    workspaceRoot,
  );
  try {
    await runtime.start(connection);
    expect(snapshot!().capabilities).toContain(AGENT_MIGRATION_CAPABILITY);
    lease!({
      protocolMajor: 1,
      requestId: "lease-1",
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      agentId: "moving-agent",
      migrationId: "migration-1",
      generation: 1,
      role: "source",
      expectedRevision: 0,
      expiresInMs: 60000,
      deadline: Date.now() + 60000,
    });
    await expect(runtime.startAgent("moving-agent", config)).rejects.toThrow(
      "moving to another Computer",
    );
  } finally {
    await runtime.stop();
  }
});
test("a daemon advertises App config and asks for each launched Agent's snapshot once per connection", async () => {
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-app-config");
  let snapshot: (() => import("@lrm/coforge-sdk/internal").DaemonRuntimeReadyRequest) | undefined;
  let reconnect: (() => void) | undefined;
  const requested: string[] = [];
  const answered = Promise.withResolvers<void>();
  const runtime = new DaemonRuntime(
    connection,
    () => ({ provider: "pi", createAgentSession: async () => sessionSpy() }),
    credentials,
    {
      create: () => ({
        async start() {},
        async stop() {},
        async ready(get) {
          snapshot = get;
        },
        onReconnect(callback) {
          reconnect = callback;
          return () => {};
        },
        async requestAgentLaunchConfig() {
          return agentLaunchConfig(`sk_agent_${"a".repeat(43)}`);
        },
        async revokeAgentApiKey() {},
        async requestAppConfigSnapshot(request) {
          requested.push(request.agentId);
          if (requested.length === 3) answered.resolve();
          return {
            ...request,
            operation: "snapshot" as const,
            configs: [],
            messageType: APP_CONFIG_SYNC_MESSAGE_TYPE,
          };
        },
      }),
    },
    undefined,
    emptyCodeAgentDiscovery,
  );
  try {
    await runtime.start(connection);
    expect(snapshot!().capabilities).toContain(APP_CONFIG_CAPABILITY);
    await runtime.startAgent("agent-a", config);
    await runtime.stopAgent("agent-a");
    await runtime.startAgent("agent-a", config);
    expect(requested).toEqual(["agent-a"]);
    reconnect!();
    await runtime.startAgent("agent-b", config);
    await answered.promise;
    expect(requested.toSorted()).toEqual(["agent-a", "agent-a", "agent-b"]);
  } finally {
    await runtime.stop();
  }
});
test("an App config the cloud pushes reaches the System Cleaner", async () => {
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-app-config");
  let receive: ((sync: import("@lrm/coforge-sdk/internal").AppConfigSync) => void) | undefined;
  const runtime = new DaemonRuntime(
    connection,
    () => ({ provider: "pi", createAgentSession: async () => sessionSpy() }),
    credentials,
    {
      create: () => ({
        async start() {},
        async stop() {},
        async ready() {},
        onAppConfigSync(callback) {
          receive = callback;
          return () => {};
        },
      }),
    },
    undefined,
    emptyCodeAgentDiscovery,
  );
  try {
    const { records } = await captureDaemonLogs(async () => {
      await runtime.start(connection);
      receive!({
        protocolMajor: 1,
        requestId: "app-config-upsert",
        workspaceId: connection.workspaceId,
        computerId: connection.computerId,
        agentId: "agent-a",
        operation: "upsert",
        configs: [
          {
            appId: CLEANER_APP_ID,
            ownerAgentId: "agent-a",
            revision: 3,
            effective: {
              enabled: false,
              thresholdBytes: 8192,
              activeContextThresholdBytes: 4000,
              intervalMs: 900000,
            },
          },
        ],
        messageType: APP_CONFIG_SYNC_MESSAGE_TYPE,
      });
    });
    expect(
      records.find((record) => record.properties.event === "system_cleaner:config_applied")
        ?.properties,
    ).toMatchObject({ agent_id: "agent-a", revision: 3, enabled: false, threshold_bytes: 8192 });
  } finally {
    await runtime.stop();
  }
});

function reminderDue(job: ReminderJob): ReminderDue {
  return {
    protocolMajor: 1,
    workspaceId: connection.workspaceId,
    computerId: connection.computerId,
    agentId: job.ownerAgentId,
    occurrenceId: crypto.randomUUID(),
    job,
    expiresAt: new Date(Date.parse(job.fireAt) + 7 * 24 * 60 * 60_000).toISOString(),
    messageType: REMINDER_DUE_MESSAGE_TYPE,
  };
}

async function reminderDueStates(stateDirectory: string, agentId = "agent-a") {
  const file = Bun.file(
    join(stateDirectory, "reminder-due", connection.workspaceId, agentId, "occurrences.json"),
  );
  if (!(await file.exists())) return [];
  const value = (await file.json()) as { occurrences: Array<{ state: string }> };
  return value.occurrences.map((occurrence) => occurrence.state);
}

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("condition was not met in time");
    await Bun.sleep(10);
  }
}
