import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";

import { AgentErrorBanner } from "#src/features/agents/profile-panel/agent-error-banner";
import { m } from "#src/paraglide/messages";

const display: AgentDisplaySnapshot = {
  protocolMajor: 1,
  workspaceId: "workspace-1",
  computerId: "computer-1",
  agentId: "agent-1",
  revision: 1,
  activityKind: "error",
  detailKind: "runtime_error",
  detail: "Provider rejected request",
  entries: [],
  expiresAt: 99_000,
};

function banner(onViewLogs?: () => void) {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <AgentErrorBanner
        agent={{
          id: "agent-1",
          workspaceId: "workspace-1",
          computerId: "computer-1",
          computerVersion: null,
          runtime: "pi",
          model: "",
          stopped: false,
          status: "online",
        }}
        display={display}
        onActivityTab={false}
        onViewLogs={onViewLogs}
      />
    </QueryClientProvider>,
  );
}

test("the error banner offers the diagnostics copy and the logs only to who gets the Activity tab", () => {
  const managers = banner(() => {});
  expect(managers).toContain("Provider rejected request");
  expect(managers).toContain(m.agent_activity_copy_diagnostics());
  expect(managers).toContain(m.agent_error_banner_view_logs());

  // Everyone else still reads the error, but gets neither: both are the Activity tab's.
  const members = banner();
  expect(members).toContain("Provider rejected request");
  expect(members).not.toContain(m.agent_activity_copy_diagnostics());
  expect(members).not.toContain(m.agent_error_banner_view_logs());
});
