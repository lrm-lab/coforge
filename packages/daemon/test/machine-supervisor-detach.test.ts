import { expect, test } from "bun:test";
import { MachineSupervisor, type ManagedBinding } from "#src/supervisor/machine-supervisor";

const NOW = 1_700_000_000_000;

test("detach stops the Workspace and removes its binding and credential only on a definite answer", async () => {
  const state = {
    saved: [
      {
        workspaceId: "a",
        computerId: "c",
        workspaceRoot: "/a",
        enabled: true,
        serverHttpUrl: "http://server",
      },
    ] as ManagedBinding[],
  };
  let stopped = 0;
  const supervisor = new MachineSupervisor(
    {
      load: async () => structuredClone(state.saved),
      save: async (next) => {
        state.saved = structuredClone(next);
      },
    },
    { start: async () => "a", stop: async () => void stopped++, instance: async () => "a" },
    () => NOW,
  );
  await supervisor.recover();
  const credentials = {
    load: async () => "sk_computer_x",
    delete: async () => {
      deleted.push(true);
    },
  };
  const deleted: boolean[] = [];
  const confirmed = {
    detach: async () => ({ ok: true as const, value: "detached" as const }),
  };
  // A definite detach: child stopped, binding gone, credential deleted.
  const done = await supervisor.detach("a", {
    credentials,
    makeSelfClient: () => confirmed,
  });
  expect(done).toEqual({ detached: true });
  expect(stopped).toBe(1);
  expect(state.saved).toEqual([]);
  expect(deleted).toEqual([true]);
});

test("detach keeps the binding and credential on any ambiguous answer", async () => {
  const state = {
    saved: [
      {
        workspaceId: "a",
        computerId: "c",
        workspaceRoot: "/a",
        enabled: true,
        serverHttpUrl: "http://server",
      },
    ] as ManagedBinding[],
  };
  let stopped = 0;
  const supervisor = new MachineSupervisor(
    {
      load: async () => structuredClone(state.saved),
      save: async (next) => {
        state.saved = structuredClone(next);
      },
    },
    { start: async () => "a", stop: async () => void stopped++, instance: async () => "a" },
    () => NOW,
  );
  const deleted: boolean[] = [];
  await supervisor.recover();
  const ambiguous = {
    detach: async () => ({
      ok: false as const,
      error: { kind: "retryable" as const, detail: "http 503" },
    }),
  };
  const result = await supervisor.detach("a", {
    credentials: {
      load: async () => "sk_computer_x",
      delete: async () => void deleted.push(true),
    },
    makeSelfClient: () => ambiguous,
  });
  // An ambiguous answer keeps everything exactly as it was.
  expect(result).toEqual({ detached: false, reason: "unconfirmed" });
  expect(stopped).toBe(0);
  expect(state.saved).toHaveLength(1);
  expect(deleted).toEqual([]);
});

test("a binding already confirmed on the server detaches locally without asking again", async () => {
  const state = {
    saved: [
      {
        workspaceId: "a",
        computerId: "c",
        workspaceRoot: "/a",
        enabled: true,
        serverHttpUrl: "http://server",
        detachConfirmed: true,
      },
    ] as ManagedBinding[],
  };
  let stopped = 0;
  const supervisor = new MachineSupervisor(
    {
      load: async () => structuredClone(state.saved),
      save: async (next) => {
        state.saved = structuredClone(next);
      },
    },
    { start: async () => "a", stop: async () => void stopped++, instance: async () => "a" },
    () => NOW,
  );
  await supervisor.recover();
  let serverCalls = 0;
  const done = await supervisor.detach("a", {
    credentials: { load: async () => "sk_computer_x", delete: async () => {} },
    makeSelfClient: () => {
      serverCalls++;
      return { detach: async () => ({ ok: true as const, value: "detached" as const }) };
    },
  });
  // The earlier server answer is the binding's `detachConfirmed` — a retry finishes the
  // local half alone and never asks again (task #417).
  expect(done).toEqual({ detached: true });
  expect(stopped).toBe(1);
  expect(serverCalls).toBe(0);
});

test("a server-confirmed detach whose local half fails persists detachConfirmed and retries locally", async () => {
  const state = {
    saved: [
      {
        workspaceId: "a",
        computerId: "c",
        workspaceRoot: "/a",
        enabled: true,
        serverHttpUrl: "http://server",
      },
    ] as ManagedBinding[],
  };
  let stopped = 0;
  const supervisor = new MachineSupervisor(
    {
      load: async () => structuredClone(state.saved),
      save: async (next) => {
        state.saved = structuredClone(next);
      },
    },
    {
      start: async () => "a",
      stop: async () => {
        stopped++;
        if (stopped === 1) throw new Error("stop failed");
      },
      instance: async () => "a",
    },
    () => NOW,
  );
  await supervisor.recover();
  let serverCalls = 0;
  const selfClient = () => {
    serverCalls++;
    return { detach: async () => ({ ok: true as const, value: "detached" as const }) };
  };
  const credentials = { load: async () => "sk_computer_x", delete: async () => {} };
  // The first call confirms the server, then its stop fails — the confirmation is on the
  // binding, so the retry does not ask the server again.
  await expect(supervisor.detach("a", { credentials, makeSelfClient: selfClient })).rejects.toThrow(
    "stop failed",
  );
  expect(serverCalls).toBe(1);
  const saved = await supervisor.view();
  const done = await supervisor.detach("a", { credentials, makeSelfClient: selfClient });
  expect(done).toEqual({ detached: true });
  expect(serverCalls).toBe(1);
});
