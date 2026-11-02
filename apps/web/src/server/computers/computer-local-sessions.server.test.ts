import { expect, test } from "bun:test";
import type {
  LocalSessionExcerptRequest,
  LocalSessionExcerptResult,
  LocalSessionSearchRequest,
  LocalSessionSearchResult,
} from "@lrm/coforge-sdk/internal";
import { ComputerLocalSessions } from "./computer-local-sessions.server";

const viewer = { userId: "user-1", workspaceId: "workspace-1" };
const computerId = "computer-1";

test("owner-authorized search publishes, waits, and rechecks ownership", async () => {
  let owned = true;
  let supported = true;
  let published: LocalSessionSearchRequest | undefined;
  let result: LocalSessionSearchResult | undefined;
  const queries = new ComputerLocalSessions(
    {
      owned: async () => owned,
      online: async () => true,
      supported: async () => supported,
      publishSearch: async (request) => {
        published = request;
        result = {
          ...request,
          sessions: [],
          scanComplete: true,
          contentSearchComplete: true,
        };
      },
      publishExcerpt: async () => {},
      searchResults: {
        begin: async () => {},
        read: async () => result,
        clear: async () => {},
      },
      excerptResults: { begin: async () => {}, read: async () => undefined, clear: async () => {} },
    },
    { now: () => 0, wait: async () => {}, timeoutMs: 10 },
  );
  expect(await queries.search(viewer, computerId, "compiler")).toEqual({
    status: "ready",
    result: expect.objectContaining({ query: "compiler" }),
  });
  expect(published).toEqual(
    expect.objectContaining({ workspaceId: viewer.workspaceId, computerId, query: "compiler" }),
  );

  owned = false;
  expect(await queries.search(viewer, computerId, "compiler")).toEqual({ status: "unavailable" });

  owned = true;
  supported = false;
  published = undefined;
  expect(await queries.search(viewer, computerId, "compiler")).toEqual({ status: "unsupported" });
  expect(published).toBeUndefined();
});

test("excerpt request and result are bound to provider, id, cwd, owner, and computer", async () => {
  let result: LocalSessionExcerptResult | undefined;
  const queries = new ComputerLocalSessions(
    {
      owned: async () => true,
      online: async () => true,
      supported: async () => true,
      publishSearch: async () => {},
      publishExcerpt: async (request: LocalSessionExcerptRequest) => {
        result = {
          ...request,
          status: "not_found",
          model: "",
          updatedAtMs: 0,
          initialRequest: "",
          recentTurns: [],
        };
      },
      searchResults: { begin: async () => {}, read: async () => undefined, clear: async () => {} },
      excerptResults: {
        begin: async () => {},
        read: async () => result,
        clear: async () => {},
      },
    },
    { now: () => 0, wait: async () => {}, timeoutMs: 10 },
  );
  expect(await queries.excerpt(viewer, computerId, "codex", "session-1", "/work/project")).toEqual({
    status: "ready",
    result: expect.objectContaining({
      provider: "codex",
      sessionId: "session-1",
      cwd: "/work/project",
      status: "not_found",
    }),
  });
});
