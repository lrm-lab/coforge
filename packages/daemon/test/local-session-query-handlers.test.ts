import { expect, test } from "bun:test";
import type {
  LocalSessionExcerptRequest,
  LocalSessionExcerptResult,
  LocalSessionSearchRequest,
  LocalSessionSearchResult,
} from "@lrm/coforge-sdk/internal";
import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";
import { subscribeLocalSessionQueries } from "#src/daemon-runtime/local-session-query-handlers";

const scope = { workspaceId: "workspace-1", computerId: "computer-1" };

test("local session handlers scope requests and reply on the receiving transport", async () => {
  let searchHandler: ((request: LocalSessionSearchRequest) => Promise<void>) | undefined;
  let excerptHandler: ((request: LocalSessionExcerptRequest) => Promise<void>) | undefined;
  const searches: LocalSessionSearchResult[] = [];
  const excerpts: LocalSessionExcerptResult[] = [];
  const transport = {
    onLocalSessionSearch(handler) {
      searchHandler = handler;
      return () => {};
    },
    onLocalSessionExcerpt(handler) {
      excerptHandler = handler;
      return () => {};
    },
    async sendLocalSessionSearchResult(result) {
      searches.push(result);
    },
    async sendLocalSessionExcerptResult(result) {
      excerpts.push(result);
    },
  } satisfies Partial<DaemonConnectionClient>;
  subscribeLocalSessionQueries(transport as DaemonConnectionClient, {
    connection: scope,
    catalog: {
      search: async () => ({ sessions: [], scanComplete: true, contentSearchComplete: true }),
      excerpt: async () => ({
        status: "not_found",
        model: "",
        updatedAtMs: 0,
        initialRequest: "",
        recentTurns: [],
      }),
    },
    currentTransport: () => transport as DaemonConnectionClient,
    isStopping: () => false,
  });
  const search = { protocolMajor: 1, requestId: "search-1", ...scope, query: "work" };
  await searchHandler?.(search);
  expect(searches).toEqual([
    { ...search, sessions: [], scanComplete: true, contentSearchComplete: true },
  ]);
  const excerpt = {
    protocolMajor: 1,
    requestId: "excerpt-1",
    ...scope,
    provider: "codex" as const,
    sessionId: "session-1",
    cwd: "/work",
  };
  await excerptHandler?.(excerpt);
  expect(excerpts).toEqual([
    {
      ...excerpt,
      status: "not_found",
      model: "",
      updatedAtMs: 0,
      initialRequest: "",
      recentTurns: [],
    },
  ]);

  await searchHandler?.({ ...search, workspaceId: "other" });
  expect(searches).toHaveLength(1);
});
