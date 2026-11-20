import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import {
  AgentMigrationNotStarted,
  notStartedAfterMove,
  useAgentMigrationNotStarted,
  writeAgentMigrationNotStarted,
} from "#src/features/agents/profile-panel/agent-migration-status";

/**
 * A direct placement (#coforge:#732) whose start did not go out reads as not started, with what to
 * press, never as a finished move (task #76). The dialog's submit runs `notStartedAfterMove` on the
 * server's answer and shows `AgentMigrationNotStarted` for what it returns; a first assignment and
 * a move off a revoked Computer word the result differently.
 */
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
  // A normal move answers with the migration it started, which reports its own progress.
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
  // The submit's refresh flips directPlacement, the section moves from INFO to ACTIONS and
  // remounts; a fresh render over the same cache still shows the note.
  expect(render()).toContain("Assigned to Studio Mac");
  expect(render()).toContain("Assigned to Studio Mac");
  writeAgentMigrationNotStarted(queryClient, "agent-1", null);
  expect(render()).not.toContain("Assigned to Studio Mac");
});
