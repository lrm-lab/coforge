import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { mockModuleForFile } from "./helpers/file-module-mock";

await mockModuleForFile("@tanstack/react-start", () => ({
  useServerFn: (serverFn: unknown) => serverFn,
}));
await mockModuleForFile("#src/features/agents/agent-migrations.functions", () => ({
  getAgentMigration: async () => {
    throw new Error("not used: the status query is seeded");
  },
  requestAgentMigration: async () => {
    throw new Error("not used");
  },
  listAgentMigrationTargets: async () => [],
  cancelAgentMigration: async () => {
    throw new Error("not used");
  },
}));
await mockModuleForFile("#src/features/workspaces/workspace-route", () => ({
  useWorkspaceSlug: () => "dev",
}));
await mockModuleForFile("#src/features/agents/profile-panel/agent-profile-queries", () => ({
  useInvalidateAgentProfile: () => async () => {},
}));

const {
  AgentMigrationNotStarted,
  notStartedAfterMove,
  useAgentMigrationNotStarted,
  writeAgentMigrationNotStarted,
} = await import("#src/features/agents/profile-panel/agent-migration-status");
const { AgentMigrationSection } =
  await import("#src/features/agents/profile-panel/agent-migration-section");

test("a direct move that did not start names its Computer and whether it was an assignment; one that started, or a normal move, does not", () => {
  expect(notStartedAfterMove({ direct: true, startPublished: false }, "Studio Mac")).toEqual({
    computerName: "Studio Mac",
    assigned: true,
  });
  expect(
    notStartedAfterMove(
      { direct: true, startPublished: false, computerAccessRevoked: true },
      "Studio Mac",
    ),
  ).toEqual({ computerName: "Studio Mac", assigned: false });
  expect(notStartedAfterMove({ direct: true, startPublished: true }, "Studio Mac")).toBeNull();
  expect(notStartedAfterMove({}, "Studio Mac")).toBeNull();
  expect(notStartedAfterMove(null, "Studio Mac")).toBeNull();
});

test("the not-started notice is a warning that says to start it, not a success", () => {
  const assigned = renderToStaticMarkup(
    <AgentMigrationNotStarted computerName="Studio Mac" assigned />,
  );
  expect(assigned).toContain("Assigned to Studio Mac");
  expect(assigned).toContain("Start the Agent manually");
  const moved = renderToStaticMarkup(
    <AgentMigrationNotStarted computerName="Studio Mac" assigned={false} />,
  );
  expect(moved).toContain("Moved to Studio Mac");
  expect(moved).not.toMatch(/success|completed|moved successfully/i);
});

function NotStartedProbe({ agentId }: { agentId: string }) {
  const { notStarted } = useAgentMigrationNotStarted(agentId);
  return notStarted ? <AgentMigrationNotStarted {...notStarted} /> : null;
}

test("the not-started note survives the section's remount when the placement lands", () => {
  const queryClient = new QueryClient();
  const render = () =>
    renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <NotStartedProbe agentId="agent-1" />
      </QueryClientProvider>,
    );
  const result = notStartedAfterMove({ direct: true, startPublished: false }, "Studio Mac");
  expect(result).not.toBeNull();
  writeAgentMigrationNotStarted(queryClient, "agent-1", result);
  expect(render()).toContain("Assigned to Studio Mac");
  expect(render()).toContain("Assigned to Studio Mac");
  writeAgentMigrationNotStarted(queryClient, "agent-1", null);
  expect(render()).not.toContain("Assigned to Studio Mac");
});

function renderSection({
  status,
  notStarted,
  canMove = true,
  agentOnline = false,
}: {
  status: Record<string, unknown> | undefined;
  notStarted: { computerName: string; assigned: boolean } | null;
  canMove?: boolean;
  agentOnline?: boolean;
}) {
  const queryClient = new QueryClient();
  if (status !== undefined) queryClient.setQueryData(["agent-migration", "agent-1"], status);
  queryClient.setQueryData(["agent-migration-not-started", "agent-1"], notStarted);
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <AgentMigrationSection
        agentId="agent-1"
        agentName="Field Notes"
        currentComputerId={null}
        canMove={canMove}
        runtime="pi"
        model="pi-default"
        agentOnline={agentOnline}
      />
    </QueryClientProvider>,
  );
}

const UNAVAILABLE = {
  available: false,
  migration: null,
  directPlacement: false,
  computerAccessRevoked: false,
};

const NOT_STARTED = { computerName: "Studio Mac", assigned: true };

test("the section keeps the not-started notice when the status read reports moving unavailable", () => {
  const html = renderSection({ status: UNAVAILABLE, notStarted: NOT_STARTED });
  expect(html).toContain("Assigned to Studio Mac");
  expect(html).toContain("Start the Agent manually");
});

test("the not-started notice is gone once the Agent is online", () => {
  const html = renderSection({
    status: UNAVAILABLE,
    notStarted: NOT_STARTED,
    agentOnline: true,
  });
  expect(html).not.toContain("Start the Agent manually");
});

test("a revoked placement reads as one status line and one action for its manager", () => {
  const html = renderSection({
    status: {
      available: true,
      migration: null,
      directPlacement: true,
      computerAccessRevoked: true,
      sourceComputerName: "Old Studio",
    },
    notStarted: null,
  });
  expect(html).toContain("Workspace disconnected from Old Studio");
  expect(html).toContain("Change Computer");
  expect(html).not.toContain("doesn&#x27;t have a Computer");
});

test("a viewer who cannot move reads the revoked line but gets no action", () => {
  const html = renderSection({
    status: {
      available: true,
      migration: null,
      directPlacement: true,
      computerAccessRevoked: true,
      sourceComputerName: "Old Studio",
    },
    notStarted: null,
    canMove: false,
  });
  expect(html).toContain("Workspace disconnected from Old Studio");
  expect(html).not.toContain("Change Computer");
  expect(html).not.toContain("Choose a Computer");
});

test("an unassigned Agent offers Choose a Computer, not a move", () => {
  const html = renderSection({
    status: {
      available: true,
      migration: null,
      directPlacement: true,
      computerAccessRevoked: false,
      sourceComputerName: null,
    },
    notStarted: null,
  });
  expect(html).toContain("No Computer assigned");
  expect(html).toContain("Choose a Computer");
  expect(html).not.toContain("Move to another Computer");
});
