import { expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";

import { AgentProfileTab } from "#src/features/agents/profile-panel/agent-profile-tab";
import type { AgentRuntimeControls } from "#src/features/agents/agent-runtime-controls";
import type { getAgentProfile } from "#src/features/agents/agents.functions";
import { formatDateForDisplay } from "#src/lib/dates";
import { m } from "#src/paraglide/messages";

type AgentProfile = NonNullable<Awaited<ReturnType<typeof getAgentProfile>>>;

/** A representative `getAgentProfile` payload; only the fields `AgentProfileTab` actually reads
 * need real values. `canManage` (owner or admin-like) is what the caller derives and passes down
 * separately, but `canManageAgentRole` on the payload itself independently gates the Role pencil. */
function profileFixture(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: "11111111-2222-4333-8444-555555555555",
    workspaceId: "workspace-1",
    name: "builder",
    displayName: "Builder",
    description: "Builds things.",
    role: "member",
    createdAt: new Date("2026-08-01T00:00:00Z"),
    computerId: "computer-1",
    computer: {
      id: "computer-1",
      label: "s144",
      kind: "local",
      computerVersion: "0.1.0-dev.35",
      online: true,
    },
    owner: { id: "user-1", username: "frank-an", displayName: "Frank An" },
    runtimeConfig: {
      runtime: "codex",
      provider: { kind: "coforge", providerId: "openai" },
      model: "gpt-5.1-codex",
      modelProvider: "openai",
      reasoning: "high",
    },
    isWeeklyReportAssistant: false,
    stopped: false,
    status: { value: "active", expiresAt: null, ordering: null },
    ownedByCurrentUser: false,
    runtimeCredential: null,
    canManageAgentRole: false,
    canFullResetAgent: false,
    runtimeUsageVisible: false,
    visibility: "public",
    canChangeVisibility: false,
    ...overrides,
  } as unknown as AgentProfile;
}

/** The Runtime badge reads cached usage through React Query, so every render gets a client; with
 * `renderToStaticMarkup` no query ever runs. */
function render(node: ReactNode) {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>,
  );
}

/** The markup's text with its tags removed: the pill splits "Context 12% used" across spans. */
function visibleText(markup: string) {
  return markup.replace(/<[^>]+>/g, "");
}

function controlsFixture(isOnline: boolean): AgentRuntimeControls {
  return {
    agentName: "Builder",
    isOnline,
    computerLabel: "s144",
    startPending: false,
    stopPending: false,
    startStopBusy: false,
    startStopError: null,
    startDeferred: false,
    pressStartOrStop: () => {},
    stopConfirmOpen: false,
    setStopConfirmOpen: () => {},
    closeStopConfirm: () => {},
    confirmStop: () => {},
    restartOpen: false,
    setRestartOpen: () => {},
    closeRestart: () => {},
    action: "restart",
    setAction: () => {},
    options: [],
    selected: { action: "restart", label: "Restart", description: "" },
    destructive: false,
    restartSubmitError: null,
    openRestart: () => {},
    submitRestart: () => {},
  } as unknown as AgentRuntimeControls;
}

const noop = async () => {};

test("a member (non-manager) sees a read-only Profile: no pencils, no Actions section", () => {
  const markup = render(
    <AgentProfileTab
      profile={profileFixture()}
      timeZone="UTC"
      canManage={false}
      controls={controlsFixture(true)}
      onSaveDisplayName={noop}
      onSaveDescription={noop}
      runtimeCredentialDialog={null}
    />,
  );
  expect(markup).toContain("Builder");
  // No edit affordance anywhere in the read-only view.
  expect(markup).not.toContain("Edit display name");
  expect(markup).not.toContain("Edit description");
  // No Actions section for a non-manager.
  expect(markup).not.toContain("Stop agent");
  expect(markup).not.toContain("Restart");
});

test("the identity block (avatar, name heading, status badge, @handle) is not repeated in the tab body — it lives only in the panel header", () => {
  const markup = render(
    <AgentProfileTab
      profile={profileFixture()}
      timeZone="UTC"
      canManage={false}
      controls={controlsFixture(true)}
      onSaveDisplayName={noop}
      onSaveDescription={noop}
      runtimeCredentialDialog={null}
    />,
  );
  expect(markup).not.toContain("@builder");
});

test("a manager (owner or admin-like) sees pencils and the Actions section", () => {
  const markup = render(
    <AgentProfileTab
      profile={profileFixture({ ownedByCurrentUser: true })}
      timeZone="UTC"
      canManage
      controls={controlsFixture(true)}
      onSaveDisplayName={noop}
      onSaveDescription={noop}
      onSaveRole={noop}
      runtimeCredentialDialog={<span data-testid="runtime-dialog-slot" />}
    />,
  );
  expect(markup).toContain("Builder");
  expect(markup).toContain("Edit display name");
  expect(markup).toContain("Edit description");
  // Online Agent: the Actions button reads "Stop agent".
  expect(markup).toContain("Stop agent");
  expect(markup).toContain('data-testid="runtime-dialog-slot"');
});

test("a stopped Agent's Actions section offers Start instead of Stop", () => {
  const markup = render(
    <AgentProfileTab
      profile={profileFixture({ ownedByCurrentUser: true, stopped: true })}
      timeZone="UTC"
      canManage
      controls={controlsFixture(false)}
      onSaveDisplayName={noop}
      onSaveDescription={noop}
      runtimeCredentialDialog={null}
    />,
  );
  expect(markup).toContain("Start agent");
  expect(markup).not.toContain("Stop agent");
});

test("a viewer without visibility into the runtime's usage sees the plain Runtime badge, no usage button", () => {
  const markup = render(
    <AgentProfileTab
      profile={profileFixture({ runtimeUsageVisible: false })}
      timeZone="UTC"
      canManage={false}
      controls={controlsFixture(true)}
      onSaveDisplayName={noop}
      onSaveDescription={noop}
      runtimeCredentialDialog={null}
    />,
  );
  expect(markup).toContain("Codex");
  expect(markup).not.toContain("Codex · Usage");
});

test('the runtime\'s owner gets a usage button labelled "<Runtime> · Usage" wrapping the badge', () => {
  const markup = render(
    <AgentProfileTab
      profile={profileFixture({ runtimeUsageVisible: true })}
      timeZone="UTC"
      canManage={false}
      controls={controlsFixture(true)}
      onSaveDisplayName={noop}
      onSaveDescription={noop}
      runtimeCredentialDialog={null}
    />,
  );
  expect(markup).toContain('aria-label="Codex · Usage"');
  expect(markup).toContain("Codex");
});

test("a runtime without usage support keeps the plain badge even for its owner", () => {
  const markup = render(
    <AgentProfileTab
      profile={profileFixture({
        runtimeUsageVisible: true,
        runtimeConfig: {
          runtime: RUNTIME_PROVIDER.PI,
          provider: { kind: "default" },
          model: "",
          modelProvider: "",
          reasoning: "",
        },
      })}
      timeZone="UTC"
      canManage={false}
      controls={controlsFixture(true)}
      onSaveDisplayName={noop}
      onSaveDescription={noop}
      runtimeCredentialDialog={null}
    />,
  );
  expect(markup).toContain("Pi");
  expect(markup).not.toContain('aria-label="Pi · Usage"');
});

test("hides the context-usage badge entirely when there is no reading", () => {
  for (const contextUsage of [undefined, null]) {
    const markup = render(
      <AgentProfileTab
        profile={profileFixture()}
        timeZone="UTC"
        canManage={false}
        controls={controlsFixture(true)}
        onSaveDisplayName={noop}
        onSaveDescription={noop}
        runtimeCredentialDialog={null}
        contextUsage={contextUsage}
      />,
    );
    expect(markup).not.toContain("Context");
  }
});

test("shows the rounded, clamped percentage next to the Runtime badge when a reading is present", () => {
  for (const [usedTokens, windowTokens, expected] of [
    [27_908, 200_000, "Context 14% used"],
    [0, 200_000, "Context 0% used"],
    // Never guessed above 100% even if a stale window makes usedTokens exceed it.
    [250_000, 200_000, "Context 100% used"],
  ] as const) {
    const markup = render(
      <AgentProfileTab
        profile={profileFixture()}
        timeZone="UTC"
        canManage={false}
        controls={controlsFixture(true)}
        onSaveDisplayName={noop}
        onSaveDescription={noop}
        runtimeCredentialDialog={null}
        contextUsage={{
          usedTokens,
          windowTokens,
          observedAtMs: Date.parse("2026-09-18T12:00:00.000Z"),
        }}
      />,
    );
    expect(visibleText(markup)).toContain(expected);
  }
});

test("a manager with a Computer sees the Runtime config pencil", () => {
  const markup = render(
    <AgentProfileTab
      profile={profileFixture({ ownedByCurrentUser: true })}
      timeZone="UTC"
      canManage
      controls={controlsFixture(true)}
      onSaveDisplayName={noop}
      onSaveDescription={noop}
      onStartRuntimeEdit={() => {}}
      runtimeCredentialDialog={null}
    />,
  );
  expect(markup).toContain(m.agent_profile_edit_runtime_config());
});

test("a non-manager never sees the Runtime config pencil", () => {
  const markup = render(
    <AgentProfileTab
      profile={profileFixture()}
      timeZone="UTC"
      canManage={false}
      controls={controlsFixture(true)}
      onSaveDisplayName={noop}
      onSaveDescription={noop}
      onStartRuntimeEdit={() => {}}
      runtimeCredentialDialog={null}
    />,
  );
  expect(markup).not.toContain(m.agent_profile_edit_runtime_config());
});

test("an Agent without a Computer still gives a manager the Runtime config pencil", () => {
  const markup = render(
    <AgentProfileTab
      profile={profileFixture({ ownedByCurrentUser: true, computerId: null, computer: undefined })}
      timeZone="UTC"
      canManage
      controls={controlsFixture(true)}
      onSaveDisplayName={noop}
      onSaveDescription={noop}
      onStartRuntimeEdit={() => {}}
      runtimeCredentialDialog={null}
    />,
  );
  expect(markup).toContain(`aria-label="${m.agent_profile_edit_runtime_config()}"`);
});

test("the Runtime config pencil never renders when the container gives no onStartRuntimeEdit", () => {
  const markup = render(
    <AgentProfileTab
      profile={profileFixture({ ownedByCurrentUser: true })}
      timeZone="UTC"
      canManage
      controls={controlsFixture(true)}
      onSaveDisplayName={noop}
      onSaveDescription={noop}
      runtimeCredentialDialog={null}
    />,
  );
  expect(markup).not.toContain(m.agent_profile_edit_runtime_config());
});

test("a non-Claude-Code Agent's context badge stays a tooltip trigger, not a popover", () => {
  const markup = render(
    <AgentProfileTab
      profile={profileFixture()}
      timeZone="UTC"
      canManage={false}
      controls={controlsFixture(true)}
      onSaveDisplayName={noop}
      onSaveDescription={noop}
      runtimeCredentialDialog={null}
      contextUsage={{
        usedTokens: 24_900,
        windowTokens: 200_000,
        observedAtMs: Date.parse("2026-09-18T12:00:00.000Z"),
      }}
    />,
  );
  expect(visibleText(markup)).toContain("Context 12% used");
  // No popover trigger/label for a runtime without a composition to read.
  expect(markup).not.toContain('aria-label="Context 12% used');
});

test("a Claude Code Agent's context badge becomes the breakdown popover trigger", () => {
  const markup = render(
    <AgentProfileTab
      profile={profileFixture({
        runtimeConfig: {
          runtime: RUNTIME_PROVIDER.CLAUDE_CODE,
          provider: { kind: "default" },
          model: "claude-sonnet-5",
          modelProvider: "",
          reasoning: "high",
        },
      })}
      timeZone="UTC"
      canManage={false}
      controls={controlsFixture(true)}
      onSaveDisplayName={noop}
      onSaveDescription={noop}
      runtimeCredentialDialog={null}
      contextUsage={{
        usedTokens: 24_900,
        windowTokens: 200_000,
        observedAtMs: Date.parse("2026-09-18T12:00:00.000Z"),
      }}
    />,
  );
  expect(visibleText(markup)).toContain("Context 12% used");
  // The popover trigger's accessible name is its visible text, then the tooltip's line
  // (used / window · time).
  expect(markup).toContain(
    `aria-label="Context 12% used · ${m.agent_context_usage_tooltip({
      used: "24,900",
      window: "200,000",
      time: formatDateForDisplay(new Date("2026-09-18T12:00:00.000Z"), "UTC", "en"),
    })}"`,
  );
});

test("a viewer who cannot change visibility sees plain Visibility text, no edit pencil", () => {
  const markup = render(
    <AgentProfileTab
      profile={profileFixture()}
      timeZone="UTC"
      canManage={false}
      controls={controlsFixture(true)}
      onSaveDisplayName={noop}
      onSaveDescription={noop}
      runtimeCredentialDialog={null}
    />,
  );
  expect(markup).toContain("Visibility");
  expect(markup).toContain("Public");
  expect(markup).not.toContain("Make private");
  expect(markup).not.toContain(m.agent_profile_edit_visibility());
});

test("the creator (or owner/admin) sees the current visibility and a pencil to change it", () => {
  const markup = render(
    <AgentProfileTab
      profile={profileFixture({ visibility: "private", canChangeVisibility: true })}
      timeZone="UTC"
      canManage
      controls={controlsFixture(true)}
      onSaveDisplayName={noop}
      onSaveDescription={noop}
      onRequestVisibilityChange={noop}
      runtimeCredentialDialog={null}
    />,
  );
  expect(markup).toContain("Private");
  expect(markup).toContain(`aria-label="${m.agent_profile_edit_visibility()}"`);
  expect(markup).not.toContain("Make public");
});

test("a private Agent without the visibility grant shows Private text with no edit affordance", () => {
  const markup = render(
    <AgentProfileTab
      profile={profileFixture({ visibility: "private", canChangeVisibility: false })}
      timeZone="UTC"
      canManage={false}
      controls={controlsFixture(true)}
      onSaveDisplayName={noop}
      onSaveDescription={noop}
      runtimeCredentialDialog={null}
    />,
  );
  expect(markup).toContain("Private");
  expect(markup).not.toContain("Make public");
  expect(markup).not.toContain(m.agent_profile_edit_visibility());
});

test("RUNTIME CONFIG is one fact per row with a Mode row that reads Default, Fast or Not applied", () => {
  const renderMode = (fastMode: boolean, observed?: "on" | "off") =>
    render(
      <AgentProfileTab
        profile={profileFixture({
          runtimeConfig: { ...profileFixture().runtimeConfig, fastMode },
        })}
        timeZone="UTC"
        canManage={false}
        controls={controlsFixture(true)}
        onSaveDisplayName={noop}
        onSaveDescription={noop}
        runtimeCredentialDialog={null}
        fastMode={observed ? { requested: fastMode, observed, observedAtMs: 1 } : null}
      />,
    );
  const off = renderMode(false);
  expect(off).toContain(m.agent_form_mode());
  expect(off).toContain(m.agent_form_default_value());
  expect(off).toContain("grid-cols-[6.5rem_minmax(0,1fr)]");
  expect(renderMode(true, "on")).toContain(m.agent_form_fast_mode());
  expect(renderMode(true, "off")).toContain(m.agent_form_fast_mode_not_applied());
});
