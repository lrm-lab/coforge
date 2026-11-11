import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  AgentMigrationNotStarted,
  notStartedAfterMove,
} from "#src/features/agents/profile-panel/agent-migration-section";

/**
 * A direct placement (#coforge:#732) whose start did not go out reads as not started, with what to
 * press, never as a finished move (task #76). The dialog's submit runs `notStartedAfterMove` on the
 * server's answer and shows `AgentMigrationNotStarted` for what it returns.
 */
test("a direct move that did not start names its Computer; one that started, or a normal move, does not", () => {
  expect(notStartedAfterMove({ direct: true, startPublished: false }, "Studio Mac")).toBe(
    "Studio Mac",
  );
  expect(notStartedAfterMove({ direct: true, startPublished: true }, "Studio Mac")).toBeNull();
  // A normal move answers with the migration it started, which reports its own progress.
  expect(notStartedAfterMove({}, "Studio Mac")).toBeNull();
  expect(notStartedAfterMove(null, "Studio Mac")).toBeNull();
});

test("the not-started notice is a warning that says to start it, not a success", () => {
  const html = renderToStaticMarkup(
    <AgentMigrationNotStarted agentName="Release Notes" computerName="Studio Mac" />,
  );
  expect(html).toContain("Release Notes moved to Studio Mac but didn&#x27;t start");
  expect(html).toContain("Press Start");
  expect(html).not.toMatch(/success|completed|moved successfully/i);
});
