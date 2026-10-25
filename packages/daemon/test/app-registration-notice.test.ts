import { afterAll, expect, setSystemTime, test } from "bun:test";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APP_REGISTRATION_NOTICE_CAPABILITY,
  APP_REGISTRATION_NOTICE_MESSAGE_TYPE,
  encodeAppRegistrationNotice,
  type AppRegistrationNotice,
} from "@lrm/coforge-sdk/internal/app-registration-notice";
import { AgentAppInbox } from "#src/agent-app-inbox/agent-app-inbox";
import { acceptAppRegistrationNotice } from "#src/agent-app-inbox/app-registration-notice";
import { APP_CLIENT_SECRET_TTL_MS } from "#src/agent-app-inbox/registry";
import type { AgentRuntimeConfig } from "@lrm/coforge-anvil";
import { DaemonConnection } from "#src/connection/daemon-connection";
import type { CentrifugeWorkspaceClient } from "#src/connection/centrifuge-workspace-client";
import { InMemoryDaemonCredentialStore } from "#src/credentials/credential-store";
import { readyCapabilities } from "#src/daemon-runtime/ready-capabilities";
import { DaemonRuntime, type WorkspaceConfig } from "#src/daemon-runtime/runtime";
import { captureDaemonLogs } from "./log-capture";
import { emptyCodeAgentDiscovery } from "./fixtures/code-agent-discovery";

/** The private notice of a new app's client secret: how it arrives, and that only the running
 * owner Agent's memory ever holds it. */

const SECRET = `cfa_secret_${"k".repeat(43)}`;
const notice: AppRegistrationNotice = {
  protocolMajor: 1,
  requestId: "notice-1",
  workspaceId: "workspace-a",
  computerId: "computer-a",
  agentId: "agent-a",
  appKey: "acme-notes",
  appName: "Acme Notes",
  clientSecret: SECRET,
  messageType: APP_REGISTRATION_NOTICE_MESSAGE_TYPE,
};

test("the daemon advertises the capability the cloud checks before sending a notice", () => {
  expect(readyCapabilities(false)).toContain(APP_REGISTRATION_NOTICE_CAPABILITY);
});

test("a notice becomes one transient inbox item, for a running Agent only", async () => {
  const minted: unknown[] = [];
  const deps = {
    isRunning: (agentId: string) => agentId === "agent-a",
    mint: async (agentId: string, item: unknown) => void minted.push({ agentId, item }),
  };
  expect(await acceptAppRegistrationNotice({ ...notice, agentId: "agent-b" }, deps)).toBe(false);
  expect(minted).toHaveLength(0);

  expect(await acceptAppRegistrationNotice(notice, deps)).toBe(true);
  expect(minted).toMatchObject([
    {
      agentId: "agent-a",
      item: {
        appId: "system.app_registry",
        notificationClass: "client_secret",
        sourceRef: { kind: "app_registration", id: "acme-notes", revision: "1" },
      },
    },
  ]);
  expect(JSON.stringify(minted)).toContain(SECRET);
});

test("an unread secret is forgotten after one TTL, counted from the last mint, with no timer", async () => {
  const directory = join(root, "ttl");
  await mkdir(directory, { recursive: true });
  const inbox = await AgentAppInbox.open(directory, "workspace-a", "agent-a");
  const mint = () =>
    acceptAppRegistrationNotice(notice, {
      isRunning: () => true,
      mint: (_agentId, item) => inbox.upsert(item),
    });
  const start = Date.now();
  try {
    await mint();
    setSystemTime(new Date(start + APP_CLIENT_SECRET_TTL_MS - 1000));
    expect(inbox.list()).toHaveLength(1);
    // A re-mint replaces the item and restarts its one TTL.
    await mint();
    setSystemTime(new Date(start + APP_CLIENT_SECRET_TTL_MS + 1000));
    expect(inbox.list()).toHaveLength(1);
    setSystemTime(new Date(start + 2 * APP_CLIENT_SECRET_TTL_MS));
    expect(inbox.list()).toHaveLength(0);
  } finally {
    setSystemTime();
  }
});

function fakeClient() {
  let connected = () => {};
  let publication = (_event: { channel: string; data: Uint8Array }) => {};
  const client: CentrifugeWorkspaceClient = {
    on(event, callback) {
      if (event === "connected") connected = callback as () => void;
      else if (event !== "disconnected" && event !== "error")
        publication = callback as typeof publication;
    },
    connect: () => connected(),
    disconnect() {},
    rpc: async () => new Uint8Array(),
  };
  return { client, publish: (channel: string, data: Uint8Array) => publication({ channel, data }) };
}

test("the connection hands a notice for this Computer to its slot, and none for another", async () => {
  const fake = fakeClient();
  const transport = new DaemonConnection("wss://cloud.example", () => fake.client);
  const received: AppRegistrationNotice[] = [];
  transport.onAppRegistrationNotice((value) => received.push(value));
  try {
    await transport.start("secret", { computerId: "computer-a", workspaceId: "workspace-a" });
    const channel = "daemon:workspace-a:computer-a";
    fake.publish(channel, encodeAppRegistrationNotice(notice));
    fake.publish(channel, encodeAppRegistrationNotice({ ...notice, computerId: "computer-b" }));
    expect(received).toEqual([notice]);
  } finally {
    await transport.stop();
  }
});

const tempRoot = realpathSync(tmpdir());
const root = join(tempRoot, `coforge-app-registration-${crypto.randomUUID()}`);
afterAll(() => rm(root, { recursive: true, force: true }));
const workspace: WorkspaceConfig = {
  computerId: "computer-a",
  workspaceId: "workspace-a",
  workspaceRoot: join(root, "workspace"),
};
const agentConfig: AgentRuntimeConfig = {
  provider: "pi",
  model: "default",
  modelProvider: "anthropic",
  reasoning: "balanced",
};

async function filesUnder(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await filesUnder(path)));
    else found.push(path);
  }
  return found;
}

test("a running Agent reads the secret from its inbox; it is on no disk and in no log", async () => {
  const stateDirectory = join(root, "state");
  await mkdir(stateDirectory, { recursive: true });
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(workspace.workspaceId, workspace.computerId, "token-a");
  let receive: ((value: AppRegistrationNotice) => void) | undefined;
  const notices: string[] = [];
  const runtime = new DaemonRuntime(
    workspace,
    () => ({
      provider: "pi",
      createAgentSession: async () => ({
        async sendMessage() {},
        subscribe: () => () => undefined,
        async interrupt() {},
        onExit: () => () => undefined,
        async dispose() {},
        notify: async (text: string) => void notices.push(text),
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
        async agentMessage(request: { idempotencyKey: string }) {
          return {
            idempotencyKey: request.idempotencyKey,
            accepted: true,
            attentionCount: 0,
            messages: [],
            hasMore: false,
          };
        },
        onAppRegistrationNotice(callback: (value: AppRegistrationNotice) => void) {
          receive = callback;
          return () => {};
        },
      }),
    },
    undefined,
    emptyCodeAgentDiscovery,
    stateDirectory,
  );
  try {
    const { records } = await captureDaemonLogs(async () => {
      await runtime.start(workspace);
      // Not running: dropped, nothing waits for a later launch.
      receive!(notice);
      await Bun.sleep(10);
      await runtime.startAgent("agent-a", agentConfig);
      receive!(notice);
      await Bun.sleep(20);
    });
    // The Agent is told only that an item is waiting; the secret is read from the inbox.
    expect(notices).toEqual(["New app item available. Run coforge inbox check."]);
    const context = runtime.issueAgentContext("agent-a");
    // An empty `message check` only counts the waiting items; it must not consume them.
    const checked = await runtime.agentMessage(
      context,
      { idempotencyKey: "message-check", context, operation: "check" },
      `sk_agent_${"a".repeat(43)}`,
    );
    expect(checked.appItemsPending).toBe(1);
    const inbox = await runtime.inbox(context, {
      idempotencyKey: "check",
      context,
      operation: "check",
    });
    const items = inbox.entries.flatMap((entry) => (entry.kind === "app" ? [entry.app] : []));
    expect(items).toHaveLength(1);
    expect(items[0]!.summary).toContain(SECRET);
    // Once means once: the first read consumed it.
    const again = await runtime.inbox(context, {
      idempotencyKey: "again",
      context,
      operation: "check",
    });
    expect(again.entries.filter((entry) => entry.kind === "app")).toHaveLength(0);

    for (const file of await filesUnder(root))
      expect(await readFile(file, "utf8").catch(() => "")).not.toContain(SECRET);
    expect(
      JSON.stringify(records.map((record) => [record.message, record.properties])),
    ).not.toContain(SECRET);
  } finally {
    await runtime.stop();
  }
});
