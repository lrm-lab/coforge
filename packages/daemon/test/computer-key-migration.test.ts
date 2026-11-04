import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  FileDaemonCredentialStore,
  InMemoryDaemonCredentialStore,
} from "#src/credentials/credential-store";
import { migrateComputerKey } from "#src/daemon-runtime/computer-key-migration";
import type { ComputerSelfResult } from "#src/connection/computer-self-client";
import { DaemonRuntime, type WorkspaceConfig } from "#src/daemon-runtime/runtime";
import { sessionSpy } from "./fixtures/session-spy";
import { emptyCodeAgentDiscovery } from "./fixtures/code-agent-discovery";

const DK = `dk_${"a".repeat(43)}`;
const DK_NEW = `dk_${"c".repeat(43)}`;
const SK = `sk_computer_${"b".repeat(43)}`;
const WORKSPACE = "01a1a700-0000-7000-8000-000000000001";
const COMPUTER = "01a1a700-0000-7000-8000-000000000002";

type Call = { method: "swap" | "confirm"; apiKey: string };

function fakeClient(handlers: {
  swap?: (apiKey: string, signal: AbortSignal) => ComputerSelfResult<{ apiKey: string }>;
  confirm?: (apiKey: string, signal: AbortSignal) => ComputerSelfResult<Record<string, never>>;
}) {
  const calls: Call[] = [];
  return {
    calls,
    client: {
      swapKey: async (apiKey: string, signal: AbortSignal) => {
        calls.push({ method: "swap", apiKey });
        return handlers.swap!(apiKey, signal);
      },
      confirmKey: async (apiKey: string, signal: AbortSignal) => {
        calls.push({ method: "confirm", apiKey });
        return handlers.confirm!(apiKey, signal);
      },
    },
  };
}

const neverAborted = new AbortController().signal;

const ports = (over: {
  apiKey?: string;
  client?: ReturnType<typeof fakeClient>["client"] | undefined;
  credentials?: Pick<
    import("#src/credentials/credential-store").DaemonCredentialStore,
    "load" | "save"
  > &
    import("#src/credentials/credential-store").DaemonCredentialConfirmations;
  signal?: AbortSignal;
}) => ({
  credentials: over.credentials ?? new InMemoryDaemonCredentialStore(),
  client: over.client,
  workspaceId: WORKSPACE,
  computerId: COMPUTER,
  apiKey: over.apiKey ?? DK,
  signal: over.signal ?? neverAborted,
});

test("a dk_ swaps, is saved, then confirms — the connection gets the sk_computer", async () => {
  const store = new InMemoryDaemonCredentialStore();
  await store.save(WORKSPACE, COMPUTER, DK);
  const { calls, client } = fakeClient({
    swap: () => ({ ok: true, value: { apiKey: SK } }),
    confirm: () => ({ ok: true, value: {} }),
  });
  const token = await migrateComputerKey(ports({ apiKey: DK, client, credentials: store }));
  expect(token).toBe(SK);
  expect(calls).toEqual([
    { method: "swap", apiKey: DK },
    { method: "confirm", apiKey: SK },
  ]);
  expect(await store.load(WORKSPACE, COMPUTER)).toBe(SK);
  expect(await store.isConfirmed(WORKSPACE, COMPUTER, SK)).toBe(true);
});

test("a stored sk_computer confirms once, then later starts skip the call entirely", async () => {
  const store = new InMemoryDaemonCredentialStore();
  await store.save(WORKSPACE, COMPUTER, SK);
  const { calls, client } = fakeClient({ confirm: () => ({ ok: true, value: {} }) });
  expect(await migrateComputerKey(ports({ apiKey: SK, client, credentials: store }))).toBe(SK);
  expect(calls).toEqual([{ method: "confirm", apiKey: SK }]);
  // Second start: the confirmation marker is set — no confirm, no request.
  expect(await migrateComputerKey(ports({ apiKey: SK, client, credentials: store }))).toBe(SK);
  expect(calls).toEqual([{ method: "confirm", apiKey: SK }]);
});

test("a stored sk_computer different from the confirmed one confirms again", async () => {
  const store = new InMemoryDaemonCredentialStore();
  const other = `sk_computer_${"d".repeat(43)}`;
  await store.markConfirmed(WORKSPACE, COMPUTER, other);
  const { calls, client } = fakeClient({ confirm: () => ({ ok: true, value: {} }) });
  expect(await migrateComputerKey(ports({ apiKey: SK, client, credentials: store }))).toBe(SK);
  expect(calls).toEqual([{ method: "confirm", apiKey: SK }]);
});

test("a server without the routes (404) keeps the dk_ and never confirms", async () => {
  const store = new InMemoryDaemonCredentialStore();
  await store.save(WORKSPACE, COMPUTER, DK);
  const { calls, client } = fakeClient({
    swap: () => ({ ok: false, error: { kind: "unsupported", detail: "http 404" } }),
  });
  const token = await migrateComputerKey(ports({ apiKey: DK, client, credentials: store }));
  expect(token).toBe(DK);
  expect(calls).toEqual([{ method: "swap", apiKey: DK }]);
});

test.each([401, 403, 500])("a %d swap answer keeps the dk_ for this start", async (status) => {
  const { calls, client } = fakeClient({
    swap: () => ({ ok: false, error: { kind: "retryable", detail: `http ${status}` } }),
  });
  const token = await migrateComputerKey(ports({ apiKey: DK, client }));
  expect(token).toBe(DK);
  expect(calls).toEqual([{ method: "swap", apiKey: DK }]);
});

test("a swapped key whose shape is not an sk_computer is never saved", async () => {
  const store = new InMemoryDaemonCredentialStore();
  await store.save(WORKSPACE, COMPUTER, DK);
  const { calls, client } = fakeClient({
    swap: () => ({ ok: true, value: { apiKey: "dk_not_a_computer_key" } }),
    confirm: () => ({ ok: true, value: {} }),
  });
  const token = await migrateComputerKey(ports({ apiKey: DK, client, credentials: store }));
  expect(token).toBe(DK);
  expect(calls).toEqual([{ method: "swap", apiKey: DK }]);
  expect(await store.load(WORKSPACE, COMPUTER)).toBe(DK);
});

test("a failed save never confirms — the dk_ would be revoked out from under the daemon", async () => {
  const { calls, client } = fakeClient({
    swap: () => ({ ok: true, value: { apiKey: SK } }),
    confirm: () => ({ ok: true, value: {} }),
  });
  const token = await migrateComputerKey(
    ports({
      apiKey: DK,
      client,
      credentials: {
        load: async () => DK,
        save: async () => {
          throw new Error("disk full");
        },
        isConfirmed: async () => false,
        markConfirmed: async () => {},
      },
    }),
  );
  expect(token).toBe(DK);
  expect(calls).toEqual([{ method: "swap", apiKey: DK }]);
});

test("a failed confirm still connects with the saved sk_computer (valid unconfirmed)", async () => {
  const store = new InMemoryDaemonCredentialStore();
  await store.save(WORKSPACE, COMPUTER, DK);
  const { calls, client } = fakeClient({
    swap: () => ({ ok: true, value: { apiKey: SK } }),
    confirm: () => ({ ok: false, error: { kind: "retryable", detail: "http 500" } }),
  });
  const token = await migrateComputerKey(ports({ apiKey: DK, client, credentials: store }));
  expect(token).toBe(SK);
  expect(calls).toEqual([
    { method: "swap", apiKey: DK },
    { method: "confirm", apiKey: SK },
  ]);
  expect(await store.load(WORKSPACE, COMPUTER)).toBe(SK);
  expect(await store.isConfirmed(WORKSPACE, COMPUTER, SK)).toBe(false);
});

test("a re-attach during the swap saves nothing: the newer dk_ wins, no confirm runs", async () => {
  // The coordinator's race: configure stores a fresh dk_ while the old start's swap is still on
  // the wire. The migration must not overwrite it with an sk the attach may already have revoked,
  // and must not confirm — a confirm would retire the new dk_ too.
  const store = new InMemoryDaemonCredentialStore();
  await store.save(WORKSPACE, COMPUTER, DK);
  const { calls, client } = fakeClient({
    swap: () => {
      void store.save(WORKSPACE, COMPUTER, DK_NEW); // re-attach lands mid-swap
      return { ok: true, value: { apiKey: SK } };
    },
    confirm: () => ({ ok: true, value: {} }),
  });
  const token = await migrateComputerKey(ports({ apiKey: DK, client, credentials: store }));
  expect(token).toBe(DK_NEW);
  expect(calls).toEqual([{ method: "swap", apiKey: DK }]);
  expect(await store.load(WORKSPACE, COMPUTER)).toBe(DK_NEW);
});

test("an abort after the swap saves nothing and confirms nothing", async () => {
  const store = new InMemoryDaemonCredentialStore();
  await store.save(WORKSPACE, COMPUTER, DK);
  const controller = new AbortController();
  const { calls, client } = fakeClient({
    swap: () => {
      controller.abort(); // the start died while swap was in flight
      return { ok: true, value: { apiKey: SK } };
    },
    confirm: () => ({ ok: true, value: {} }),
  });
  const token = await migrateComputerKey(
    ports({ apiKey: DK, client, credentials: store, signal: controller.signal }),
  );
  expect(token).toBe(DK);
  expect(calls).toEqual([{ method: "swap", apiKey: DK }]);
  expect(await store.load(WORKSPACE, COMPUTER)).toBe(DK);
});

test("an abort after the save skips the confirm — it could revoke a newer attach's key", async () => {
  const store = new InMemoryDaemonCredentialStore();
  await store.save(WORKSPACE, COMPUTER, DK);
  const controller = new AbortController();
  const { calls, client } = fakeClient({
    swap: () => ({ ok: true, value: { apiKey: SK } }),
    confirm: () => ({ ok: true, value: {} }),
  });
  const saving = {
    load: (w: string, c: string) => store.load(w, c),
    save: async (w: string, c: string, key: string) => {
      await store.save(w, c, key);
      controller.abort(); // the abort lands while the save is settling
    },
    isConfirmed: (w: string, c: string, k: string) => store.isConfirmed(w, c, k),
    markConfirmed: (w: string, c: string, k: string) => store.markConfirmed(w, c, k),
  };
  const token = await migrateComputerKey(
    ports({ apiKey: DK, client, credentials: saving, signal: controller.signal }),
  );
  expect(token).toBe(SK);
  expect(calls).toEqual([{ method: "swap", apiKey: DK }]);
  expect(await store.load(WORKSPACE, COMPUTER)).toBe(SK);
  expect(await store.isConfirmed(WORKSPACE, COMPUTER, SK)).toBe(false);
});

test("no server URL keeps the stored key untouched", async () => {
  const token = await migrateComputerKey(ports({ apiKey: DK, client: undefined }));
  expect(token).toBe(DK);
});

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test("the migrated key lands in the same credential file an older daemon reads (downgrade)", async () => {
  // The downgrade answer (task #417): FileDaemonCredentialStore names one file per
  // (workspaceId, computerId) pair — the only slot an older daemon ever reads. Writing the
  // sk_computer through the same save() means a downgraded daemon picks it up unchanged and the
  // server accepts it everywhere, so no re-attach is needed.
  const directory = await mkdtemp(join(tmpdir(), "coforge-key-migration-"));
  directories.push(directory);
  const fileStore = new FileDaemonCredentialStore(directory);
  await fileStore.save(WORKSPACE, COMPUTER, DK);
  const { client } = fakeClient({
    swap: () => ({ ok: true, value: { apiKey: SK } }),
    confirm: () => ({ ok: true, value: {} }),
  });
  const token = await migrateComputerKey(ports({ apiKey: DK, client, credentials: fileStore }));
  expect(token).toBe(SK);
  // What an older binary reads on its next start, from its own store implementation.
  const olderStore = new FileDaemonCredentialStore(directory);
  expect(await olderStore.load(WORKSPACE, COMPUTER)).toBe(SK);
});

test("the runtime migrates the stored key before opening the connection", async () => {
  // RuntimeStartup seam: the migration runs between credentials.load and transport.start, so the
  // token the connection opens with is the sk_computer, not the stored dk_.
  const sk = `sk_computer_${"e".repeat(43)}`;
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      requests.push(path);
      return Response.json(path.endsWith("swap-key") ? { apiKey: sk } : { ok: true });
    },
  });
  const workspaceRoot = await mkdtemp(join(tmpdir(), "coforge-key-startup-"));
  directories.push(workspaceRoot);
  try {
    const credentials = new InMemoryDaemonCredentialStore();
    await credentials.save(WORKSPACE, COMPUTER, "dk_a");
    const connection: WorkspaceConfig = {
      workspaceId: WORKSPACE,
      computerId: COMPUTER,
      workspaceRoot,
      serverHttpUrl: `http://127.0.0.1:${server.port}`,
    };
    let startedWith: string | undefined;
    const runtime = new DaemonRuntime(
      connection,
      () => ({ provider: "pi", createAgentSession: async () => sessionSpy() }),
      credentials,
      {
        create: () => ({
          async start(token) {
            startedWith = token;
          },
          async stop() {},
          async ready() {},
        }),
      },
      undefined,
      emptyCodeAgentDiscovery,
      workspaceRoot,
    );
    try {
      await runtime.start(connection);
      expect(startedWith).toBe(sk);
      expect(requests).toEqual(["/api/computer/swap-key", "/api/computer/confirm-key"]);
      expect(await credentials.load(WORKSPACE, COMPUTER)).toBe(sk);
    } finally {
      await runtime.stop();
    }
  } finally {
    server.stop(true);
  }
});

test("a confirmation marker that cannot be read means unconfirmed — startup still proceeds", async () => {
  // The marker file must never hold startup hostage: a corrupt or unreadable .confirmed is
  // treated as "not confirmed" and the start does one extra confirm.
  const directory = await mkdtemp(join(tmpdir(), "coforge-key-marker-"));
  directories.push(directory);
  const store = new FileDaemonCredentialStore(directory);
  await store.save(WORKSPACE, COMPUTER, SK);
  // A directory where the marker file belongs makes the read fail with EISDIR, not ENOENT.
  const markerPath = join(
    directory,
    "credentials",
    `${encodeURIComponent(WORKSPACE)}-${encodeURIComponent(COMPUTER)}.api-key.confirmed`,
  );
  await mkdir(markerPath, { recursive: true });
  expect(await store.isConfirmed(WORKSPACE, COMPUTER, SK)).toBe(false);
  const { calls, client } = fakeClient({ confirm: () => ({ ok: true, value: {} }) });
  expect(await migrateComputerKey(ports({ apiKey: SK, client, credentials: store }))).toBe(SK);
  expect(calls).toEqual([{ method: "confirm", apiKey: SK }]);
});
