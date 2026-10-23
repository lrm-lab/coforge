import { expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { AppBotInstallation } from "#src/features/apps/app-bot-grant";
import { BotSection } from "#src/features/apps/app-editor-bot";
import { AppCard } from "#src/features/apps/app-card";
import { AppBotProfile } from "#src/features/agents/profile-panel/app-bot-profile";
import { AgentProfileTab } from "#src/features/agents/profile-panel/agent-profile-tab";
import { canManageAgent } from "#src/features/agents/profile-panel/agent-profile-queries";
import type { AppBotSummary } from "#src/features/apps/app-bot";
import type { AppSummary } from "#src/features/apps/apps.functions";
import type { getAgentProfile } from "#src/features/agents/agents.functions";

/**
 * The bot's surfaces as markup: the installation's Enable bot / Bot enabled / Disable bot, shown
 * only where `app-bot` is on and the app declares a bot; the editor's switch; the card's badge;
 * and the bot's profile, which hides the Computer and runtime sections.
 */
type AgentProfile = NonNullable<Awaited<ReturnType<typeof getAgentProfile>>>;

const render = (node: ReactNode) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>,
  );
const noop = async () => {};
const off: AppBotSummary = { installationId: "i-1", granted: false, statusText: null };
const on: AppBotSummary = { installationId: "i-1", granted: true, statusText: "Indexing 2,341" };

function installation(declares: boolean, bot: AppBotSummary | undefined, canManage = true) {
  return render(
    <AppBotInstallation
      declares={{ bot: declares }}
      app={{ key: "acme", bot }}
      canManage={canManage}
      onChanged={noop}
    />,
  );
}

test("an owner or admin sees Enable bot while the bot is off, and Bot enabled with Disable bot once granted", () => {
  const before = installation(true, off);
  expect(before).toContain("Enable bot");
  expect(before).not.toContain("Bot enabled");
  expect(before).not.toContain("Disable bot");
  const after = installation(true, on);
  expect(after).toContain("Bot enabled");
  expect(after).toContain("Disable bot");
  expect(after).toContain("Status: Indexing 2,341");
  expect(after).not.toContain(">Enable bot<");
});

test("a member sees the state but no control", () => {
  const markup = installation(true, off, false);
  expect(markup).not.toContain(">Enable bot<");
  expect(markup).toContain("Ask a Workspace owner or admin to enable the bot.");
  expect(installation(true, on, false)).not.toContain("Disable bot");
});

test("with app-bot off, or an app that declares no bot, the installation shows nothing", () => {
  expect(installation(false, off)).toBe("");
  expect(installation(false, on)).toBe("");
  expect(installation(true, undefined)).toBe("");
});

test("the editor's Bot section is a switch that waits for the app to exist", () => {
  const registering = render(
    <BotSection id="bot" appKey={undefined} declared={false} isDisabled={false} onChanged={noop} />,
  );
  expect(registering).toContain("Enable bot");
  expect(registering).toContain("Save the app before enabling its bot.");
  expect(registering).toContain("disabled");
  const editing = render(
    <BotSection id="bot" appKey="acme" declared isDisabled={false} onChanged={noop} />,
  );
  expect(editing).toContain("Turning this off revokes every Workspace");
});

const app = {
  key: "acme",
  name: "Acme",
  category: "other",
  description: "",
  homepageUrl: null,
  logoUrl: null,
  owned: true,
  listed: false,
  developer: "Acme",
} as unknown as AppSummary;

test("the app card says Bot enabled only for a granted bot", () => {
  const card = (bot?: AppBotSummary) =>
    render(<AppCard app={{ ...app, ...(bot && { bot }) }} view="installed" layout="grid" />);
  expect(card(on)).toContain("Bot enabled");
  expect(card(off)).not.toContain("Bot enabled");
  expect(card()).not.toContain("Bot enabled");
});

const botProfile = {
  id: "11111111-2222-4333-8444-555555555555",
  workspaceId: "workspace-1",
  name: "acme",
  displayName: "Acme Reviews",
  description: "Reviews things",
  role: "member",
  createdAt: new Date("2026-08-01T00:00:00Z"),
  computerId: null,
  computer: undefined,
  owner: { id: "user-1", username: "frank-an", displayName: "Frank An" },
  runtimeConfig: { runtime: "pi", provider: { kind: "default" }, model: "", reasoning: "" },
  appBot: {
    appKey: "acme",
    appName: "Acme Reviews",
    logoUrl: null,
    statusText: "Indexing 2,341",
  },
  ownedByCurrentUser: true,
  canManageAgentRole: true,
} as unknown as AgentProfile;

test("a bot's profile names the app, shows the Bot badge and status, and hides runtime and Computer", () => {
  const markup = render(
    <AgentProfileTab
      profile={botProfile}
      timeZone="UTC"
      canManage={false}
      controls={{} as never}
      onSaveDisplayName={noop}
      onSaveDescription={noop}
      runtimeCredentialDialog={null}
    />,
  );
  expect(markup).toContain("Acme Reviews");
  expect(markup).toContain(">Bot<");
  expect(markup).toContain("Managed by app: Acme Reviews");
  expect(markup).toContain("Indexing 2,341");
  for (const hidden of ["Runtime", "Computer", "Model", "Restart", "Edit display name"])
    expect(markup).not.toContain(hidden);
});

test("nobody manages a bot from its profile, not even its creator or an admin", () => {
  expect(canManageAgent({ canManageAgentRole: true, ownedByCurrentUser: true })).toBe(true);
  expect(
    canManageAgent({ canManageAgentRole: true, ownedByCurrentUser: true, appBot: { appKey: "a" } }),
  ).toBe(false);
});

test("AppBotProfile alone renders the same bot profile", () => {
  const markup = render(
    <AppBotProfile profile={{ ...botProfile, appBot: botProfile.appBot! }} timeZone="UTC" />,
  );
  expect(markup).toContain("@acme");
});
