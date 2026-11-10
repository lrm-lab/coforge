import { expect, test } from "bun:test";
import type {
  CodeAgentModelCatalog,
  DaemonRuntimeProviderModelRefreshRequest,
  DaemonRuntimeProviderModelRefreshResponse,
  ProviderModelRefreshResult,
  RuntimeProvider,
  RuntimeUnavailableCode,
} from "@lrm/coforge-sdk/internal";
import {
  ComputerModelCatalogRefresh,
  MODEL_CATALOG_REFRESH_PENDING_TTL_SECONDS,
} from "#src/server/computers/computer-model-catalog-refresh.server";
import { RUNTIME_CATALOG_REFRESH_CLIENT_DEADLINE_MS } from "#src/features/computers/runtime-catalog-refresh-poll";

const viewer = { userId: "user-1", workspaceId: "workspace-1" };
const scope = { workspaceId: "workspace-1", computerId: "computer-1" };

const catalog = (provider: RuntimeProvider): CodeAgentModelCatalog => ({ provider, models: [] });
const failed = (
  provider: RuntimeProvider,
  code: RuntimeUnavailableCode,
  diagnostic?: string,
): ProviderModelRefreshResult => ({ provider, status: "error", code, diagnostic });
const refreshed = (provider: RuntimeProvider): ProviderModelRefreshResult => ({
  provider,
  status: "refreshed",
  catalog: catalog(provider),
});

/** A use case over a results store the test fills the way the Computer's result RPC would. */
function useCase(
  options: {
    allowed?: boolean | (() => boolean);
    visible?: RuntimeProvider[];
    publishFails?: boolean;
    beginFails?: boolean;
    detectionFails?: boolean;
  } = {},
) {
  const marks: string[] = [];
  const published: DaemonRuntimeProviderModelRefreshRequest[] = [];
  // What the Computer has answered so far, by request id.
  const answers = new Map<string, DaemonRuntimeProviderModelRefreshResponse>();
  const allowed = () =>
    typeof options.allowed === "function" ? options.allowed() : (options.allowed ?? true);
  const refresh = new ComputerModelCatalogRefresh({
    authorize: async () => {
      marks.push("authorize");
      return allowed();
    },
    visibleProviders: async () => {
      marks.push("visible");
      return new Set<RuntimeProvider>(options.visible ?? ["codex", "claude-code"]);
    },
    detection: {
      begin: async (_scope, requestId) => {
        marks.push(`detect:${requestId}`);
        if (options.detectionFails) throw new Error("redis is down");
      },
      end: async (_scope, requestId) => void marks.push(`end:${requestId}`),
    },
    results: {
      begin: async (pending) => {
        expect(pending.revision).toBe("");
        marks.push("begin");
        if (options.beginFails) throw new Error("redis is down");
      },
      read: async (requestId) => {
        marks.push("read");
        return answers.get(requestId);
      },
    },
    publish: async (request) => {
      marks.push("publish");
      if (options.publishFails) throw new Error("centrifugo is down");
      published.push(request);
    },
  });
  /** The Computer answers the request that was published last. */
  const answer = (value: Partial<DaemonRuntimeProviderModelRefreshResponse> = {}) => {
    const request = published.at(-1)!;
    answers.set(request.requestId, {
      protocolMajor: 1,
      requestId: request.requestId,
      workspaceId: request.workspaceId,
      computerId: request.computerId,
      accepted: true,
      results: [refreshed("codex")],
      ...value,
    });
  };
  /** Starts a refresh and returns what its read names. */
  const start = async (provider?: RuntimeProvider) => {
    const started = await refresh.start(viewer, { computerId: scope.computerId, provider });
    if (started.status !== "started") throw new Error("not started");
    return { computerId: scope.computerId, provider, requestId: started.requestId };
  };
  return { refresh, marks, published, answer, start };
}

test("starting detects, records and publishes one probe, and returns its request id without waiting", async () => {
  const { refresh, marks, published } = useCase();
  const started = await refresh.start(viewer, { computerId: "computer-1", provider: "codex" });
  expect(started).toEqual({ status: "started", requestId: published[0]!.requestId });
  expect(published).toHaveLength(1);
  expect(published[0]).toMatchObject({
    protocolMajor: 1,
    workspaceId: "workspace-1",
    computerId: "computer-1",
    provider: "codex",
  });
  // The Computer is detecting from the start, and stays so until its result ends it: starting
  // never reads, never waits and never ends the mark.
  expect(marks).toEqual(["authorize", `detect:${published[0]!.requestId}`, "begin", "publish"]);
});

test("a rescan of the whole Computer names no provider", async () => {
  const { refresh, published } = useCase();
  await refresh.start(viewer, { computerId: "computer-1" });
  expect(published[0]).not.toHaveProperty("provider");
});

test("a Computer the viewer cannot reach is refused before anything is marked, recorded or sent", async () => {
  const { refresh, marks } = useCase({ allowed: false });
  expect(await refresh.start(viewer, { computerId: "computer-1" })).toEqual({
    status: "refused",
  });
  expect(marks).toEqual(["authorize"]);
});

test("a request that could not go out fails and does not leave the Computer detecting", async () => {
  for (const options of [{ detectionFails: true }, { beginFails: true }, { publishFails: true }]) {
    const { refresh, marks, published } = useCase(options);
    expect(await refresh.start(viewer, { computerId: "computer-1" })).toEqual({
      status: "failed",
    });
    expect(published).toHaveLength(0);
    // Ends its own request's mark, which no result will ever end.
    expect(marks.at(-1)).toMatch(/^end:/);
    expect(marks.at(-1)).toBe(
      marks.find((mark) => mark.startsWith("detect:"))!.replace("detect:", "end:"),
    );
  }
});

test("a read is pending, and does no authorization, until the Computer has answered", async () => {
  const { refresh, marks, start } = useCase();
  const request = await start();
  marks.length = 0;
  expect(await refresh.read(viewer, request)).toEqual({ status: "pending" });
  expect(marks).toEqual(["read"]);
});

test("an answer is read only by the Workspace and Computer it was asked for", async () => {
  const { refresh, marks, answer, start } = useCase();
  const request = await start();
  answer();
  marks.length = 0;
  for (const foreign of [
    { viewer: { ...viewer, workspaceId: "workspace-2" }, computerId: request.computerId },
    { viewer, computerId: "computer-2" },
  ]) {
    expect(
      await refresh.read(foreign.viewer, { ...request, computerId: foreign.computerId }),
    ).toEqual({ status: "pending" });
  }
  // A foreign caller reaches neither the authorization nor the catalogs.
  expect(marks).toEqual(["read", "read"]);
});

test("an answer is returned only while the viewer still reaches the Computer", async () => {
  let allowed = true;
  const { refresh, answer, start, marks } = useCase({ allowed: () => allowed });
  const request = await start();
  answer();
  allowed = false;
  marks.length = 0;
  // Nothing of the answer is returned, though both lookups ran side by side.
  expect(await refresh.read(viewer, request)).toEqual({ status: "refused" });
});

test("a named refresh returns its own fresh catalog", async () => {
  const { refresh, answer, start, marks } = useCase();
  const request = await start("codex");
  answer({ results: [refreshed("codex"), refreshed("claude-code")] });
  marks.length = 0;
  expect(await refresh.read(viewer, request)).toEqual({
    status: "settled",
    outcome: { status: "refreshed", catalog: catalog("codex") },
  });
  // The stored result already ended the Computer's detecting; reading changes nothing.
  expect(marks).toEqual(["read", "authorize", "visible"]);
});

test("a named refresh that failed reports the runtime's classified reason and no catalog", async () => {
  const { refresh, answer, start } = useCase();
  const request = await start("codex");
  answer({ results: [failed("codex", "probe_failed", "codex not found")] });
  expect(await refresh.read(viewer, request)).toEqual({
    status: "settled",
    outcome: {
      status: "error",
      provider: "codex",
      code: "probe_failed",
      diagnostic: "codex not found",
    },
  });
});

test("a whole-Computer rescan returns every visible fresh catalog", async () => {
  const { refresh, answer, start } = useCase({ visible: ["codex"] });
  const request = await start();
  answer({ results: [refreshed("codex"), refreshed("claude-code")] });
  // A runtime the viewer may not see is not returned.
  expect(await refresh.read(viewer, request)).toEqual({
    status: "settled",
    outcome: { status: "refreshed", catalogs: [catalog("codex")] },
  });
});

test("a whole-Computer rescan with a failed runtime returns that runtime's reason", async () => {
  const { refresh, answer, start } = useCase();
  const request = await start();
  answer({ results: [refreshed("codex"), failed("claude-code", "start_failed")] });
  expect(await refresh.read(viewer, request)).toMatchObject({
    status: "settled",
    outcome: { status: "error", provider: "claude-code", code: "start_failed" },
  });
});

test("a Computer that rejected the probe settles as an error with no reason", async () => {
  const { refresh, answer, start } = useCase();
  const request = await start();
  answer({ accepted: false, results: [] });
  expect(await refresh.read(viewer, request)).toEqual({
    status: "settled",
    outcome: { status: "error" },
  });
});

test("the page stops asking after the request can no longer be answered", () => {
  // Longer than the Daemon's 45 second probe budget, and inside the pending request's lifetime.
  expect(RUNTIME_CATALOG_REFRESH_CLIENT_DEADLINE_MS).toBeGreaterThan(45_000);
  expect(RUNTIME_CATALOG_REFRESH_CLIENT_DEADLINE_MS).toBeLessThan(
    MODEL_CATALOG_REFRESH_PENDING_TTL_SECONDS * 1_000,
  );
});
