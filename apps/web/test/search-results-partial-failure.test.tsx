import { expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { MessageSearchHit } from "#src/server/conversations/message-search.server";

import { mockModuleForFile } from "./helpers/file-module-mock";

const TASK_HIT = {
  id: "t1",
  number: 2,
  title: "Verify beacon task",
  status: "todo",
  conversation: { id: "c1", channelName: "general" },
};

const ARTIFACT_HIT = {
  id: "a1",
  title: "Beacon Spec",
  entryPath: "README.md",
  currentVersion: 1,
};

let taskMode: "empty" | "hit" | "fail" = "empty";
let artifactMode: "empty" | "hit" | "fail" = "empty";

await mockModuleForFile("@tanstack/react-router", () => ({
  Link: ({ children, ...props }: { children?: ReactNode; className?: string }) => (
    <a className={props.className}>{children}</a>
  ),
  useRouterState: ({
    select,
  }: {
    select: (state: { location: { pathname: string } }) => unknown;
  }) => select({ location: { pathname: "/en/w/demo" } }),
}));
await mockModuleForFile("#src/features/workspaces/workspace-route", () => ({
  useWorkspaceSlug: () => "demo",
}));
await mockModuleForFile("#src/features/conversations/chat-lists.functions", () => ({
  loadChatLists: async () => ({
    channelNames: { value: { streamPositions: {}, names: [] } },
  }),
}));
await mockModuleForFile("#src/features/workspaces/workspaces.functions", () => ({
  loadWorkspaceDirectory: async () => ({ viewerId: "u1", people: [], agents: [] }),
}));
await mockModuleForFile("#src/features/computers/computers.functions", () => ({
  listComputerNames: async () => [],
}));
await mockModuleForFile("#src/features/search/search.functions", () => ({
  searchWorkspaceMessages: async () => ({
    results: [],
    hasMore: false,
    searchedAt: new Date("2026-11-24T00:00:00.000Z"),
  }),
  searchWorkspaceTasks: async () => {
    if (taskMode === "fail") throw new Error("forced task 503");
    return taskMode === "hit" ? [TASK_HIT] : [];
  },
  searchWorkspaceArtifacts: async () => {
    if (artifactMode === "fail") throw new Error("forced artifact 503");
    return artifactMode === "hit" ? [ARTIFACT_HIT] : [];
  },
}));

const { SearchResults } = await import("#src/features/search/search-results");
const { artifactSearchQuery, messageSearchQuery, searchDirectoryQuery, taskSearchQuery } =
  await import("#src/features/search/search-queries");

const EMPTY_MESSAGES_PAGE = {
  results: [],
  hasMore: false,
  searchedAt: new Date("2026-11-24T00:00:00.000Z"),
  rangeFrom: "2026-11-24T00:00:00.000Z",
};

const MESSAGE_HIT: MessageSearchHit = {
  conversation: {
    id: "c1",
    channelName: "general",
    visibility: "public",
    directKey: null,
    archived: false,
    direct: null,
  },
  message: {
    id: "m1",
    sequence: 1,
    body: "Deploying beacon checklist",
    createdAt: "2026-11-24T00:00:00.000Z",
    senderMemberId: "cm1",
    senderKind: "user",
    senderName: "Alice",
    senderHandle: undefined,
    senderAgentId: undefined,
    senderUserId: "u1",
    senderDeleted: false,
    senderAvatarUrl: null,
    threadRootId: undefined,
    mentions: [],
    attachments: [],
    reactions: [],
    reactionVersion: 0,
    actionCard: undefined,
    forwarded: undefined,
  },
};

function createTestClient() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: 60_000 } },
  });
  client.setQueryData(searchDirectoryQuery("w1").queryKey, {
    viewerId: "u1",
    canCreateAgents: false,
    people: [],
    agents: [],
    channels: [],
    computers: [],
  });
  return client;
}

function renderResults(client: QueryClient, query: string, channelId?: string) {
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <SearchResults
        workspaceId="w1"
        timeZone={null}
        query={query}
        filters={channelId ? { channelId } : {}}
        onOpen={() => {}}
        onClear={() => {}}
      />
    </QueryClientProvider>,
  );
}

test("task failure with zero hits elsewhere renders task error + retry instead of global no-results", async () => {
  taskMode = "fail";
  artifactMode = "empty";
  const client = createTestClient();
  client.setQueryData(messageSearchQuery("w1", "orphan", {}, null).queryKey, {
    pages: [EMPTY_MESSAGES_PAGE],
    pageParams: [{ offset: 0 }],
  });
  await client.fetchQuery(taskSearchQuery("w1", "orphan", undefined, undefined)).catch(() => {});
  await client.fetchQuery(artifactSearchQuery("w1", "orphan", undefined));

  const html = renderResults(client, "orphan");
  expect(html).toContain("Could not search tasks.");
  expect(html).toContain("Try again");
  expect(html).toContain("No messages match.");
  expect(html).not.toContain("No results for");
});

test("artifact failure with zero hits elsewhere renders artifact error + retry instead of global no-results", async () => {
  taskMode = "empty";
  artifactMode = "fail";
  const client = createTestClient();
  client.setQueryData(messageSearchQuery("w1", "orphan", {}, null).queryKey, {
    pages: [EMPTY_MESSAGES_PAGE],
    pageParams: [{ offset: 0 }],
  });
  await client.fetchQuery(taskSearchQuery("w1", "orphan", undefined, undefined));
  await client.fetchQuery(artifactSearchQuery("w1", "orphan", undefined)).catch(() => {});

  const html = renderResults(client, "orphan");
  expect(html).toContain("Could not search Artifacts.");
  expect(html).toContain("Try again");
  expect(html).toContain("No messages match.");
  expect(html).not.toContain("No results for");
});

test("task partial failure preserves returned message and artifact hits", async () => {
  taskMode = "fail";
  artifactMode = "hit";
  const client = createTestClient();
  client.setQueryData(messageSearchQuery("w1", "beacon", {}, null).queryKey, {
    pages: [{ ...EMPTY_MESSAGES_PAGE, results: [MESSAGE_HIT] }],
    pageParams: [{ offset: 0 }],
  });
  await client.fetchQuery(taskSearchQuery("w1", "beacon", undefined, undefined)).catch(() => {});
  await client.fetchQuery(artifactSearchQuery("w1", "beacon", undefined));

  const html = renderResults(client, "beacon");
  expect(html).toContain("Could not search tasks.");
  expect(html).toContain("Beacon");
  expect(html).toContain("checklist");
  expect(html).not.toContain("No results for");
});

test("artifact partial failure preserves returned message and task hits", async () => {
  taskMode = "hit";
  artifactMode = "fail";
  const client = createTestClient();
  client.setQueryData(messageSearchQuery("w1", "beacon", {}, null).queryKey, {
    pages: [{ ...EMPTY_MESSAGES_PAGE, results: [MESSAGE_HIT] }],
    pageParams: [{ offset: 0 }],
  });
  await client.fetchQuery(taskSearchQuery("w1", "beacon", undefined, undefined));
  await client.fetchQuery(artifactSearchQuery("w1", "beacon", undefined)).catch(() => {});

  const html = renderResults(client, "beacon");
  expect(html).toContain("Could not search Artifacts.");
  expect(html).toContain("Verify");
  expect(html).toContain("checklist");
  expect(html).not.toContain("No results for");
});

test("shows global no-results only when every participating group succeeded with empty results", async () => {
  taskMode = "empty";
  artifactMode = "empty";
  const client = createTestClient();
  client.setQueryData(messageSearchQuery("w1", "empty", {}, null).queryKey, {
    pages: [EMPTY_MESSAGES_PAGE],
    pageParams: [{ offset: 0 }],
  });
  await client.fetchQuery(taskSearchQuery("w1", "empty", undefined, undefined));
  await client.fetchQuery(artifactSearchQuery("w1", "empty", undefined));

  const html = renderResults(client, "empty");
  expect(html).toContain("No results for");
  expect(html).not.toContain("Could not search");
});

test("filter-only search with empty query shows no-matching-messages even when task/artifact queries are disabled", async () => {
  taskMode = "hit";
  artifactMode = "fail";
  const client = createTestClient();
  client.setQueryData(messageSearchQuery("w1", "", { channelId: "c-ops" }, null).queryKey, {
    pages: [EMPTY_MESSAGES_PAGE],
    pageParams: [{ offset: 0 }],
  });
  await client.fetchQuery(taskSearchQuery("w1", "stale", "c-ops", undefined));
  await client.fetchQuery(artifactSearchQuery("w1", "stale", "c-ops")).catch(() => {});

  const html = renderResults(client, "", "c-ops");
  expect(html).toContain("No matching messages");
  expect(html).not.toContain("Could not search");
  expect(html).not.toContain("Verify");
});

test("background refresh failure preserves same-query task hits alongside inline retry", async () => {
  taskMode = "hit";
  artifactMode = "empty";
  const client = createTestClient();
  client.setQueryData(messageSearchQuery("w1", "beacon", {}, null).queryKey, {
    pages: [EMPTY_MESSAGES_PAGE],
    pageParams: [{ offset: 0 }],
  });
  await client.fetchQuery(taskSearchQuery("w1", "beacon", undefined, undefined));
  await client.fetchQuery(artifactSearchQuery("w1", "beacon", undefined));

  taskMode = "fail";
  await client.refetchQueries({
    queryKey: taskSearchQuery("w1", "beacon", undefined, undefined).queryKey,
  });

  const html = renderResults(client, "beacon");
  const text = html.replace(/<[^>]+>/g, "");
  expect(text).toContain("Could not search tasks.");
  expect(text).toContain("Try again");
  expect(text).toContain("Verify beacon task");
  expect(text).not.toContain("No results for");
});

test("background refresh failure preserves same-query artifact hits alongside inline retry", async () => {
  taskMode = "empty";
  artifactMode = "hit";
  const client = createTestClient();
  client.setQueryData(messageSearchQuery("w1", "beacon", {}, null).queryKey, {
    pages: [EMPTY_MESSAGES_PAGE],
    pageParams: [{ offset: 0 }],
  });
  await client.fetchQuery(taskSearchQuery("w1", "beacon", undefined, undefined));
  await client.fetchQuery(artifactSearchQuery("w1", "beacon", undefined));

  artifactMode = "fail";
  await client.refetchQueries({
    queryKey: artifactSearchQuery("w1", "beacon", undefined).queryKey,
  });

  const html = renderResults(client, "beacon");
  const text = html.replace(/<[^>]+>/g, "");
  expect(text).toContain("Could not search Artifacts.");
  expect(text).toContain("Try again");
  expect(text).toContain("Beacon Spec");
  expect(text).not.toContain("No results for");
});
