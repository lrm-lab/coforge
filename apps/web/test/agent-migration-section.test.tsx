import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  AgentMigrationForm,
  AgentMigrationStatus,
} from "#src/features/agents/profile-panel/agent-migration-section";
import { m } from "#src/paraglide/messages";

/** `Modal` renders nothing under `renderToStaticMarkup`, so the dialog's body is rendered alone. */
test("the move dialog offers only online Computers, and says what moves and what stays", () => {
  const markup = renderToStaticMarkup(
    <AgentMigrationForm
      computers={[
        { id: "computer-b", displayName: "Studio Mac", online: true },
        { id: "computer-c", displayName: "Old Laptop", online: false },
      ]}
      selected={null}
      onSelect={() => {}}
    />,
  );
  expect(markup).toContain(m.agent_migration_dialog_target());
  expect(markup).toContain(m.agent_migration_dialog_session());
  expect(markup).toContain(m.agent_migration_dialog_stops());
  expect(markup).toContain("work/");
  expect(markup).not.toContain(m.agent_migration_dialog_no_targets());

  const none = renderToStaticMarkup(
    <AgentMigrationForm
      computers={[{ id: "computer-c", displayName: "Old Laptop", online: false }]}
      selected={null}
      onSelect={() => {}}
    />,
  );
  expect(none).toContain(m.agent_migration_dialog_no_targets());
});

test("a move in progress shows its stage and, for its owner, a cancel; a finished one shows no cancel", () => {
  const going = renderToStaticMarkup(
    <AgentMigrationStatus
      migration={{ state: "source_stopped", errorCode: null }}
      targetName="Studio Mac"
      onCancel={() => {}}
    />,
  );
  expect(going).toContain(m.agent_migration_status_uploading({ computer: "Studio Mac" }));
  expect(going).toContain(m.agent_migration_cancel());

  const failed = renderToStaticMarkup(
    <AgentMigrationStatus
      migration={{ state: "failed", errorCode: "bucket_refused" }}
      targetName="Studio Mac"
      onCancel={() => {}}
    />,
  );
  expect(failed).toContain(m.agent_migration_reason_transfer());
  expect(failed).toContain("text-error-primary");
  expect(failed).not.toContain(m.agent_migration_cancel());

  const watching = renderToStaticMarkup(
    <AgentMigrationStatus
      migration={{ state: "placing", errorCode: null }}
      targetName="Studio Mac"
    />,
  );
  expect(watching).not.toContain(m.agent_migration_cancel());
});
