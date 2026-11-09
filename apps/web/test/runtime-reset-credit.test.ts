import { expect, test } from "bun:test";
import {
  encodeDaemonRuntimeResetCreditConsumeResponse,
  type DaemonRuntimeResetCreditConsumeRequest,
  type DaemonRuntimeResetCreditConsumeResponse,
} from "@lrm/coforge-sdk/internal";
import { createDaemonRuntimeResetCreditConsumeResultMethod } from "#src/server/centrifugo/reset-credit-result.server";
import { RedisResetCreditResults } from "#src/server/centrifugo/reset-credit-cache.server";
import { decodeUsageSnapshot } from "#src/server/centrifugo/usage-snapshot-decode.server";
import type { UsageResultRecord } from "#src/server/centrifugo/usage-cache.server";
import { RuntimeResetCredit } from "#src/server/computers/runtime-reset-credit.server";

const principal = { userId: "user-1", workspaceId: "workspace-1" };
const key = "0b8c1f3e-52d7-4a9c-9a4e-6f1d2c3b4a59";
const input = { computerId: "computer-1", provider: "codex" as const, idempotencyKey: key };

type Answer = Partial<DaemonRuntimeResetCreditConsumeResponse>;

/** A use case over a results store the test fills the way the Computer's result RPC would. */
function useCase(
  options: {
    allowed?: boolean;
    online?: boolean;
    supported?: boolean;
    publishFails?: boolean;
  } = {},
) {
  const marks: string[] = [];
  const published: DaemonRuntimeResetCreditConsumeRequest[] = [];
  // What the Computer has answered so far, by request id.
  const answers = new Map<string, DaemonRuntimeResetCreditConsumeResponse>();
  const useCase = new RuntimeResetCredit({
    authorization: {
      canManage: async () => {
        marks.push("authorize");
        return options.allowed ?? true;
      },
    },
    computerStatus: { get: async () => options.online ?? true },
    capability: { supports: async () => options.supported ?? true },
    results: {
      begin: async () => void marks.push("begin"),
      read: async (requestId) => answers.get(requestId),
    },
    publish: async (request) => {
      marks.push("publish");
      if (options.publishFails) throw new Error("centrifugo is down");
      published.push(request);
    },
  });
  /** The Computer answers the request that was published last. */
  const answer = (value: Answer = {}) => {
    const request = published.at(-1)!;
    answers.set(request.requestId, {
      protocolMajor: 1,
      requestId: request.requestId,
      workspaceId: request.workspaceId,
      computerId: request.computerId,
      provider: request.provider,
      outcome: "reset",
      ...value,
    });
  };
  return { useCase, marks, published, answer };
}

test("starting asks the Computer once, with the attempt's key as given, and returns without any answer", async () => {
  const { useCase: attempt, marks, published } = useCase();
  const started = await attempt.start(principal, input);
  expect(started).toEqual({ status: "started", requestId: published[0]!.requestId });
  expect(published).toHaveLength(1);
  expect(published[0]).toMatchObject({
    protocolMajor: 1,
    workspaceId: "workspace-1",
    computerId: "computer-1",
    provider: "codex",
    idempotencyKey: key,
  });
  // The request stays pending for the Computer's answer: starting never clears or waits.
  expect(marks).toEqual(["authorize", "begin", "publish"]);
});

test("a read is pending until the Computer answers, then settles on its outcome", async () => {
  const { useCase: attempt, answer } = useCase();
  const started = await attempt.start(principal, input);
  if (started.status !== "started") throw new Error("expected a started attempt");
  const read = () => attempt.read(principal, { ...input, requestId: started.requestId });
  expect(await read()).toEqual({ status: "pending" });
  answer({ outcome: "no_credit" });
  expect(await read()).toEqual({ status: "settled", outcome: "no_credit" });
  // A page that lost the reply can ask again.
  expect(await read()).toEqual({ status: "settled", outcome: "no_credit" });
});

test("every outcome the Computer settles comes back as it is", async () => {
  for (const outcome of [
    "reset",
    "nothing_to_reset",
    "no_credit",
    "already_redeemed",
    "reauth_required",
    "unsupported",
    "unknown",
  ] as const) {
    const { useCase: attempt, answer } = useCase();
    const started = await attempt.start(principal, input);
    if (started.status !== "started") throw new Error("expected a started attempt");
    answer({ outcome });
    expect(await attempt.read(principal, { ...input, requestId: started.requestId })).toEqual({
      status: "settled",
      outcome,
    });
  }
});

test("a person who may not manage the Computer's runtimes spends nothing and asks nobody", async () => {
  const { useCase: attempt, marks } = useCase({ allowed: false });
  expect(await attempt.start(principal, input)).toEqual({ status: "refused", reason: "forbidden" });
  expect(marks).toEqual(["authorize"]);
});

test("a non-manager never receives an outcome, however it is asked for", async () => {
  const answered = new RuntimeResetCredit({
    authorization: { canManage: async () => false },
    computerStatus: { get: async () => true },
    capability: { supports: async () => true },
    results: {
      begin: async () => {},
      read: async (requestId) => ({
        protocolMajor: 1,
        requestId,
        workspaceId: "workspace-1",
        computerId: "computer-1",
        provider: "codex",
        outcome: "reset",
      }),
    },
    publish: async () => {},
  });
  expect(await answered.read(principal, { ...input, requestId: crypto.randomUUID() })).toEqual({
    status: "refused",
    reason: "forbidden",
  });
});

test("a read with no answer yet is pending and asks nobody for authorization", async () => {
  const { useCase: attempt, marks } = useCase();
  const started = await attempt.start(principal, input);
  if (started.status !== "started") throw new Error("expected a started attempt");
  marks.length = 0;
  expect(await attempt.read(principal, { ...input, requestId: started.requestId })).toEqual({
    status: "pending",
  });
  expect(marks).toEqual([]);
});

test("an answer is not readable through another Workspace, Computer or runtime", async () => {
  const { useCase: attempt, answer } = useCase();
  const started = await attempt.start(principal, input);
  if (started.status !== "started") throw new Error("expected a started attempt");
  const requestId = started.requestId;
  for (const scope of [
    { workspaceId: "workspace-2" },
    { computerId: "computer-2" },
    { provider: "claude-code" as const },
  ]) {
    answer(scope);
    expect(await attempt.read(principal, { ...input, requestId })).toEqual({ status: "pending" });
  }
  answer();
  expect(await attempt.read(principal, { ...input, requestId })).toEqual({
    status: "settled",
    outcome: "reset",
  });
  // The same answer, asked for as another Workspace's principal, is not theirs either.
  expect(
    await attempt.read({ ...principal, workspaceId: "workspace-2" }, { ...input, requestId }),
  ).toEqual({ status: "pending" });
});

test("an offline Computer and one too old to know the action are refused before anything is sent", async () => {
  const offline = useCase({ online: false });
  expect(await offline.useCase.start(principal, input)).toEqual({
    status: "refused",
    reason: "offline",
  });
  const old = useCase({ supported: false });
  expect(await old.useCase.start(principal, input)).toEqual({
    status: "refused",
    reason: "needs_upgrade",
  });
  expect(offline.marks).toEqual(["authorize"]);
  expect(old.marks).toEqual(["authorize"]);
});

test("a request that may have been delivered is started and stays pending, so the page ends at unknown", async () => {
  // Publishing can fail after the Computer already has the request: nothing says the credit was
  // not spent, so this is neither a refusal nor a cleared request.
  const { useCase: attempt, marks } = useCase({ publishFails: true });
  const started = await attempt.start(principal, input);
  expect(started).toEqual({ status: "started", requestId: expect.any(String) });
  expect(marks).toEqual(["authorize", "begin", "publish"]);
  if (started.status !== "started") return;
  expect(await attempt.read(principal, { ...input, requestId: started.requestId })).toEqual({
    status: "pending",
  });
});

test("a store that cannot record the request is a failure, not a refusal", async () => {
  const failing = new RuntimeResetCredit({
    authorization: { canManage: async () => true },
    computerStatus: { get: async () => true },
    capability: { supports: async () => true },
    results: {
      begin: async () => {
        throw new Error("redis is down");
      },
      read: async () => undefined,
    },
    publish: async () => {
      throw new Error("must not publish a request nobody can answer");
    },
  });
  await expect(failing.start(principal, input)).rejects.toThrow("redis is down");
});

test("a key outside the boundary's shape is refused before it can reach a Computer", async () => {
  const { useCase: attempt, marks } = useCase();
  await expect(attempt.start(principal, { ...input, idempotencyKey: "short" })).rejects.toThrow(
    "invalid reset credit idempotency key",
  );
  expect(marks).toEqual([]);
});

// -- The Computer's answer ---------------------------------------------------------------

const metadata = {
  principal: { userId: "computer-user", workspaceId: "workspace-1", computerId: "computer-1" },
};
const reply = {
  protocolMajor: 1,
  requestId: "request-1",
  workspaceId: "workspace-1",
  computerId: "computer-1",
  provider: "codex" as const,
  outcome: "reset" as const,
};
const snapshot = { provider: "codex", health: "ok", resetCreditsAvailable: 1 };
const encode = (value: object) => new TextEncoder().encode(JSON.stringify(value));

function resultMethod(options: { cacheFails?: boolean } = {}) {
  const accepted: DaemonRuntimeResetCreditConsumeResponse[] = [];
  const cached: UsageResultRecord[] = [];
  const order: string[] = [];
  const method = createDaemonRuntimeResetCreditConsumeResultMethod({
    results: {
      accept: async (response) => {
        order.push("outcome");
        accepted.push(response);
        return true;
      },
    },
    usageCache: {
      putResult: async (record) => {
        order.push("usage");
        if (options.cacheFails) throw new Error("redis is down");
        cached.push(record);
      },
    },
  });
  return { method, accepted, cached, order };
}

test("the Computer's answer is stored for the waiting page and its usage lands in the usage cache first", async () => {
  const { method, accepted, cached, order } = resultMethod();
  expect(
    await method(
      encodeDaemonRuntimeResetCreditConsumeResponse({ ...reply, snapshotJson: encode(snapshot) }),
      metadata,
    ),
  ).toEqual(new Uint8Array());
  expect(accepted.map((response) => response.outcome)).toEqual(["reset"]);
  // The page re-reads usage as soon as it sees the outcome, so the reading is already there.
  expect(order).toEqual(["usage", "outcome"]);
  // The page waits on the outcome alone; the reading goes to the cache the popover reads.
  expect(accepted[0]!.snapshotJson).toBeUndefined();
  expect(cached).toHaveLength(1);
  expect(cached[0]).toMatchObject({
    workspaceId: "workspace-1",
    computerId: "computer-1",
    provider: "codex",
    scanId: "request-1",
    status: "available",
    snapshot: { resetCreditsAvailable: 1 },
  });
});

test("a reading the server cannot trust never costs the outcome", async () => {
  const { method, accepted, cached } = resultMethod();
  await method(
    encodeDaemonRuntimeResetCreditConsumeResponse({
      ...reply,
      snapshotJson: encode({ ...snapshot, provider: "claude-code" }),
    }),
    metadata,
  );
  expect(accepted.map((response) => response.outcome)).toEqual(["reset"]);
  expect(cached).toEqual([]);
});

test("a usage cache that fails never costs the outcome", async () => {
  const { method, accepted } = resultMethod({ cacheFails: true });
  expect(
    await method(
      encodeDaemonRuntimeResetCreditConsumeResponse({ ...reply, snapshotJson: encode(snapshot) }),
      metadata,
    ),
  ).toEqual(new Uint8Array());
  expect(accepted.map((response) => response.outcome)).toEqual(["reset"]);
});

test("an answer from another Computer, or a malformed one, is refused", async () => {
  const { method, accepted, cached } = resultMethod();
  const payload = encodeDaemonRuntimeResetCreditConsumeResponse(reply);
  expect(
    await method(payload, { principal: { ...metadata.principal, computerId: "other" } }),
  ).toEqual({ code: 403, message: "daemon runtime identity is not authorized" });
  expect(
    await method(
      encodeDaemonRuntimeResetCreditConsumeResponse({ ...reply, requestId: "" }),
      metadata,
    ),
  ).toEqual({ code: 400, message: "invalid reset credit result" });
  expect(accepted).toEqual([]);
  expect(cached).toEqual([]);
});

test("the pending request, not the Computer, decides whose answer a page receives", async () => {
  const store = new Map<string, string>();
  const redis = {
    get: async (name: string) => store.get(name) ?? null,
    set: async (name: string, value: string) => {
      store.set(name, value);
      return "OK";
    },
    // `accept` stores the result only while the pending value it compared is still current.
    send: async (command: string, args: string[]) => {
      if (command === "DEL") for (const name of args) store.delete(name);
      if (command === "EVAL") {
        const [, , pendingKey, resultKey, pending, result] = args;
        if (store.get(pendingKey!) !== pending) return 0;
        store.set(resultKey!, result!);
        return 1;
      }
      return 1;
    },
  };
  const results = new RedisResetCreditResults(redis as never);
  const request: DaemonRuntimeResetCreditConsumeRequest = { ...reply, idempotencyKey: key };
  await results.begin({ request, userId: "user-1", revision: "" });
  expect(await results.accept({ ...reply, workspaceId: "workspace-2" })).toBe(false);
  expect(await results.accept({ ...reply, provider: "claude-code" })).toBe(false);
  expect(await results.accept(reply)).toBe(true);
  expect((await results.read("request-1"))?.outcome).toBe("reset");
});

// -- The usage reading's count ----------------------------------------------------------

test("the reset credit count passes only as a whole number from 0 to 999", () => {
  const decoded = (resetCreditsAvailable: unknown) =>
    decodeUsageSnapshot(encode({ provider: "codex", resetCreditsAvailable }), "codex")
      ?.resetCreditsAvailable;
  expect(decoded(0)).toBe(0);
  expect(decoded(3)).toBe(3);
  expect(decoded(999)).toBe(999);
  for (const implausible of [1000, -1, 1.5, "3", null, true, Number.NaN])
    expect(decoded(implausible)).toBeUndefined();
  expect(decodeUsageSnapshot(encode({ provider: "codex" }), "codex")).toEqual({
    provider: "codex",
  });
});
