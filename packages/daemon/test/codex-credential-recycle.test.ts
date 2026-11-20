import { afterAll, beforeEach, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentRuntimeConfig,
  AgentRuntimeEvent,
  AgentSession,
  AgentSessionOptions,
  RuntimeAuthAdapter,
} from "@lrm/coforge-anvil";
import type {
  AgentActivity,
  AgentCredentialRestored,
  AgentStartIntent,
  AgentStatus,
  MentionDeliveryEnvelope,
  RuntimeAuthIntent,
} from "@lrm/coforge-sdk/internal";
import { InMemoryDaemonCredentialStore } from "#src/credentials/credential-store";
import { DaemonRuntime, type DaemonConfig } from "#src/daemon-runtime/runtime";
import type { AgentConsumedSeqState } from "#src/persistence/agent-consumed-seq-store";
import { emptyCodeAgentDiscovery } from "./fixtures/code-agent-discovery";
import { seedCursor } from "./fixtures/consumed-cursor";
import { messageRecord } from "./fixtures/message-record";

const tempRoot = realpathSync(tmpdir());
const workspaceRoot = join(tempRoot, `coforge-codex-cred-recycle-${crypto.randomUUID()}`);
const connection: DaemonConfig = {
  computerId: "computer-a",
  workspaceId: "workspace-a",
  workspaceRoot,
};
const codexConfig: AgentRuntimeConfig = {
  provider: "codex",
  model: "gpt-5",
  reasoning: "balanced",
};
const AUTH_ERROR = "access token could not be refreshed";

afterAll(() => rm(workspaceRoot, { recursive: true, force: true }));
beforeEach(() =>
  seedCursor(
    "agent-a",
    { targets: {}, aliases: {}, nextReadOrder: 1 } as AgentConsumedSeqState,
    workspaceRoot,
  ),
);

async function codexHarness(
  options: {
    agentConfig?: AgentRuntimeConfig;
    startBusy?: boolean;
  } = {},
) {
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");
  const activities: AgentActivity[] = [];
  const statuses: AgentStatus[] = [];
  const restored: AgentCredentialRestored[] = [];
  const acks: string[] = [];
  const launchIds: string[] = [];
  const sessions: Array<{
    launch: number;
    sessionIdArg: string | undefined;
    notices: string[];
    noticeDeliveryIds: Array<readonly string[] | undefined>;
    disposed: boolean;
    liveTurn: boolean;
    emit(event: AgentRuntimeEvent): void;
  }> = [];
  let onAuthIntent: ((intent: RuntimeAuthIntent) => Promise<void> | void) | undefined;

  const adapter = {
    provider: "codex",
    startLogin: async () => ({
      status: "logged_in",
      authStatus: { provider: "codex", state: "logged_in" },
    }),
    readStatus: async () => ({ provider: "codex", state: "logged_in" }),
    submitCode: async () => {},
    cancel: async () => {},
    logout: async () => ({
      status: "logged_out",
      authStatus: { provider: "codex", state: "logged_out" },
    }),
  } as unknown as RuntimeAuthAdapter;

  const agentConfig = options.agentConfig ?? codexConfig;
  const runtime = new DaemonRuntime(
    connection,
    () => ({
      provider: "codex",
      async createAgentSession(sessionOptions: AgentSessionOptions) {
        const launch = sessions.length + 1;
        const listeners = new Set<(event: AgentRuntimeEvent) => void>();
        const exitListeners = new Set<() => void>();
        const record = {
          launch,
          sessionIdArg: sessionOptions.sessionId,
          notices: [] as string[],
          noticeDeliveryIds: [] as Array<readonly string[] | undefined>,
          disposed: false,
          liveTurn: false,
          emit(event: AgentRuntimeEvent) {
            if (event.type === "completed") record.liveTurn = false;
            for (const listener of listeners) listener(event);
          },
        };
        sessions.push(record);
        await sessionOptions.onSessionId?.("codex-thread-1");
        return {
          get hasLiveTurn() {
            return record.liveTurn;
          },
          async sendMessage() {
            if (options.startBusy && launch === 1) {
              record.liveTurn = true;
              for (const listener of listeners) listener({ type: "progress" });
              return;
            }
            for (const listener of listeners) listener({ type: "completed", status: "completed" });
          },
          async notify(notice: string, noticeOptions?: { deliveryIds?: readonly string[] }) {
            record.notices.push(notice);
            record.noticeDeliveryIds.push(noticeOptions?.deliveryIds);
          },
          subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          async interrupt() {},
          onExit(listener) {
            exitListeners.add(listener);
            return () => exitListeners.delete(listener);
          },
          async dispose() {
            record.disposed = true;
            for (const listener of exitListeners) listener();
          },
        } satisfies AgentSession;
      },
    }),
    credentials,
    {
      create: () => ({
        async start() {},
        async ready() {},
        async stop() {},
        onRuntimeAuth(listener) {
          onAuthIntent = listener;
          return () => {
            onAuthIntent = undefined;
          };
        },
        async reportRuntimeAuthLogin() {},
        async reportRuntimeAuthLogout() {},
        async reportRuntimeAuthStatus() {},
        async requestAgentLaunchConfig() {
          return {
            agentApiKey: `sk_agent_${"a".repeat(43)}`,
            ...(agentConfig.envVars ? { envVars: agentConfig.envVars } : {}),
          };
        },
        async revokeAgentApiKey() {},
        sendAgentActivity(activity) {
          activities.push(activity);
        },
        sendAgentStatus(status) {
          statuses.push(status);
        },
        async sendAgentCredentialRestored(report) {
          restored.push(report);
        },
        async sendAgentControlResult() {},
        async reportAgentSession(report) {
          launchIds.push(report.launchId);
        },
        async agentMessage(request) {
          return {
            idempotencyKey: request.idempotencyKey,
            accepted: true,
            attentionCount: 0,
            hasMore: false,
            messages: [messageRecord(1, "@codex", "#general")],
          };
        },
        async sendAgentDeliveryAck(ack) {
          acks.push(ack.deliveryId);
        },
        async sendAgentDeliveryRejection() {},
        async sendAgentMentionDeliveryTransition() {},
        async sendAgentMentionDeliveryTerminalError() {},
      }),
    },
    undefined,
    emptyCodeAgentDiscovery,
    workspaceRoot,
    undefined,
    undefined,
    undefined,
    () => adapter,
  );
  await runtime.start(connection);
  await runtime.startAgent("agent-a", agentConfig);

  const deliver = (sequence: number, mentionDelivery?: MentionDeliveryEnvelope) =>
    runtime.handleAgentMessage({
      protocolMajor: 1,
      requestId: `req-${sequence}`,
      messageId: `msg-${sequence}`,
      deliveryId: `delivery-${sequence}`,
      sequence,
      workspaceId: connection.workspaceId,
      conversationId: "conv-a",
      agentId: "agent-a",
      body: `body-${sequence}`,
      method: "agent:v1:message:deliver",
      target: "#general",
      mentionsAgent: true,
      ...(mentionDelivery ? { mentionDelivery } : {}),
    });

  const signIn = () =>
    onAuthIntent?.({
      protocolMajor: 1,
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      kind: "login_start",
      loginId: `rtl_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
      provider: "codex",
    });

  const signOut = () =>
    onAuthIntent?.({
      protocolMajor: 1,
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      kind: "logout",
      requestId: `rlo_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
      provider: "codex",
    });

  return {
    runtime,
    sessions,
    activities,
    statuses,
    restored,
    acks,
    launchIds,
    deliver,
    signIn,
    signOut,
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for expected state");
    await Bun.sleep(5);
  }
}

test("re-signing in to Codex recycles a held Codex app-server and delivers kept messages on the fresh process", async () => {
  const h = await codexHarness();
  try {
    h.sessions[0]!.emit({ type: "progress" });
    h.sessions[0]!.emit({ type: "error", message: AUTH_ERROR });
    h.sessions[0]!.emit({ type: "completed", status: "failed" });

    await h.deliver(1, {
      messageId: "msg-1",
      launchId: h.launchIds.at(-1) ?? "missing",
      sessionId: "codex-thread-1",
      computerId: connection.computerId,
    });
    expect(h.sessions[0]!.notices).toEqual([]);

    await h.signIn();

    await waitUntil(() => h.sessions.length === 2 && h.sessions[1]!.notices.length === 1);
    expect(h.sessions[0]!.disposed).toBe(true);
    expect(h.sessions[0]!.notices).toEqual([]);
    expect(h.sessions[1]!.sessionIdArg).toBe("codex-thread-1");
    expect(h.sessions[1]!.noticeDeliveryIds[0]).toEqual(["delivery-1"]);
    expect(h.restored).toMatchObject([
      { agentId: "agent-a", reason: "user_reauth", releaseCause: "credentials_changed" },
    ]);
  } finally {
    await h.runtime.stop();
  }
});

test("signing out of Codex recycles a healthy idle Codex app-server so the next message launches fresh", async () => {
  const h = await codexHarness();
  try {
    await h.signOut();
    await waitUntil(() => h.sessions[0]!.disposed);

    expect(h.statuses.some((status) => status.status === "inactive")).toBe(false);
    expect(h.sessions).toHaveLength(1);

    await h.deliver(1);
    await waitUntil(() => h.sessions.length === 2 && h.sessions[1]!.notices.length === 1);
    expect(h.sessions[1]!.sessionIdArg).toBe("codex-thread-1");
  } finally {
    await h.runtime.stop();
  }
});

test("signing in while a Codex Agent is mid-turn waits for the turn to finish before recycling", async () => {
  const h = await codexHarness({ startBusy: true });
  try {
    await h.signIn();
    await Bun.sleep(50);
    expect(h.sessions[0]!.disposed).toBe(false);

    h.sessions[0]!.emit({ type: "completed", status: "completed" });
    await waitUntil(() => h.sessions[0]!.disposed);
    expect(h.sessions).toHaveLength(1);
  } finally {
    await h.runtime.stop();
  }
});

test("pressing Start on a live held Codex Agent stops the stale process and spawns one fresh process", async () => {
  const h = await codexHarness();
  try {
    await h.runtime.stopAgent("agent-a");
    const startIntent = (epoch: number, launchId: string): AgentStartIntent => ({
      protocolMajor: 1,
      requestId: `start-${epoch}`,
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      agentId: "agent-a",
      ...codexConfig,
      controlEpoch: epoch,
      launchId,
    });
    await h.runtime.handleAgentStart(startIntent(1, "launch-1"));
    const live = h.sessions.at(-1)!;
    live.emit({ type: "progress" });
    live.emit({ type: "error", message: AUTH_ERROR });
    live.emit({ type: "completed", status: "failed" });
    await h.deliver(1, {
      messageId: "msg-1",
      launchId: "launch-1",
      sessionId: "codex-thread-1",
      computerId: connection.computerId,
    });

    const countBeforeStart = h.sessions.length;
    await h.runtime.handleAgentStart(startIntent(2, "launch-2"));
    await waitUntil(
      () => h.sessions.length === countBeforeStart + 1 && h.sessions.at(-1)!.notices.length === 1,
    );

    expect(live.disposed).toBe(true);
    expect(live.notices).toEqual([]);
    expect(h.sessions).toHaveLength(countBeforeStart + 1);
    expect(h.sessions.at(-1)!.noticeDeliveryIds[0]).toEqual(["delivery-1"]);
    expect(h.restored).toMatchObject([
      { agentId: "agent-a", reason: "user_reauth", releaseCause: "explicit_start" },
    ]);
  } finally {
    await h.runtime.stop();
  }
});

test("a Codex Agent with its own CODEX_HOME is not recycled by Computer-level sign-out or sign-in", async () => {
  const h = await codexHarness({
    agentConfig: { ...codexConfig, envVars: { CODEX_HOME: "/agent/codex-home" } },
  });
  try {
    await h.signOut();
    await h.signIn();
    await Bun.sleep(50);
    expect(h.sessions[0]!.disposed).toBe(false);
    expect(h.sessions).toHaveLength(1);
  } finally {
    await h.runtime.stop();
  }
});

test("pressing Start on a busy held Codex Agent rebinds mid-turn, then recycles and wakes on turn end to deliver parked work", async () => {
  const h = await codexHarness();
  try {
    await h.runtime.stopAgent("agent-a");
    const startIntent = (
      agentId: string,
      epoch: number,
      launchId: string,
      requestId = `start-${agentId}-${epoch}`,
    ): AgentStartIntent => ({
      protocolMajor: 1,
      requestId,
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      agentId,
      ...codexConfig,
      controlEpoch: epoch,
      launchId,
    });
    await h.runtime.handleAgentStart(startIntent("agent-a", 1, "launch-a-1"));
    const sessionA = h.sessions.at(-1)!;
    await h.runtime.handleAgentStart(startIntent("agent-b", 1, "launch-b-1"));
    const sessionB = h.sessions.at(-1)!;

    sessionA.liveTurn = true;
    sessionA.emit({ type: "progress" });
    sessionB.emit({ type: "progress" });
    sessionB.emit({ type: "error", message: AUTH_ERROR });
    sessionB.emit({ type: "completed", status: "failed" });

    await h.deliver(1, {
      messageId: "msg-1",
      launchId: "launch-a-1",
      sessionId: "codex-thread-1",
      computerId: connection.computerId,
    });
    expect(sessionA.notices).toEqual([]);

    const countBeforeStart = h.sessions.length;
    await h.runtime.handleAgentStart(startIntent("agent-a", 2, "launch-a-2"));
    expect(sessionA.disposed).toBe(false);

    sessionA.emit({ type: "completed", status: "completed" });
    await waitUntil(
      () =>
        sessionA.disposed &&
        h.sessions.length === countBeforeStart + 1 &&
        h.sessions.at(-1)!.notices.length === 1,
    );
    expect(sessionA.notices).toEqual([]);
    expect(h.sessions.at(-1)!.noticeDeliveryIds[0]).toEqual(["delivery-1"]);
  } finally {
    await h.runtime.stop();
  }
});

test("replayed and stale managed Starts do not lift a hold or recycle a live held Codex Agent", async () => {
  const h = await codexHarness();
  try {
    await h.runtime.stopAgent("agent-a");
    const startIntent = (epoch: number, launchId: string, requestId: string): AgentStartIntent => ({
      protocolMajor: 1,
      requestId,
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      agentId: "agent-a",
      ...codexConfig,
      controlEpoch: epoch,
      launchId,
    });
    await h.runtime.handleAgentStart(startIntent(2, "launch-2", "req-start-2"));
    const live = h.sessions.at(-1)!;
    live.emit({ type: "progress" });
    live.emit({ type: "error", message: AUTH_ERROR });
    live.emit({ type: "completed", status: "failed" });
    await h.deliver(1, {
      messageId: "msg-1",
      launchId: "launch-2",
      sessionId: "codex-thread-1",
      computerId: connection.computerId,
    });

    await h.runtime.handleAgentStart(startIntent(2, "launch-2", "req-start-2"));
    await expect(
      h.runtime.handleAgentStart(startIntent(1, "launch-1", "req-start-1")),
    ).rejects.toThrow("stale_control_request");

    expect(live.disposed).toBe(false);
    expect(live.notices).toEqual([]);
    expect(h.restored).toEqual([]);
  } finally {
    await h.runtime.stop();
  }
});
