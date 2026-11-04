import { useEffect, useId, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { Button } from "#src/components/base/buttons/button";
import { Checkbox } from "#src/components/base/checkbox/checkbox";
import { Select } from "#src/components/base/select/select";
import { SettingsCardFooter, SettingsField } from "#src/components/settings-layout";
import { saveErrorFrom, type SaveError } from "#src/components/save-error";
import { useSubmitGuard } from "#src/hooks/use-submit-guard";
import { m } from "#src/paraglide/messages";
import {
  loadWorkspaceOnboarding,
  saveWorkspaceOnboarding,
  type WorkspaceOnboardingSettings,
} from "./onboarding.functions";

/** The Workspace's cache is cleared on a Workspace switch, so the key needs no Workspace id. */
const ONBOARDING_QUERY_KEY = ["settings-member-onboarding"];

/** The picker's one key for the three modes: the two fixed choices, or `agent:<id>`. */
type WelcomeKey = "assistant" | "off" | `agent:${string}`;

function welcomeKey(settings: Pick<WorkspaceOnboardingSettings, "mode" | "agentId">): WelcomeKey {
  return settings.mode === "agent" && settings.agentId
    ? `agent:${settings.agentId}`
    : settings.mode === "off"
      ? "off"
      : "assistant";
}

/**
 * Settings → Members → New member onboarding (task #344), for a Workspace owner or admin: who
 * welcomes someone who joins (each member's own assistant, one chosen Agent, or nobody), and
 * whether Agents created from now on say hello in #general. One Save for both, as System channels
 * beside it: these change what every newcomer and every new Agent does.
 */
export function MemberOnboardingSettings() {
  const load = useServerFn(loadWorkspaceOnboarding);
  const query = useQuery({ queryKey: ONBOARDING_QUERY_KEY, queryFn: () => load() });
  if (query.isPending) return null;
  if (query.isError)
    return (
      <p role="alert" className="py-6 text-sm text-error-primary">
        {m.member_onboarding_load_error()}
      </p>
    );
  // Anyone but an owner or admin reads `null`, and sees nothing.
  return query.data ? <OnboardingForm settings={query.data} /> : null;
}

function OnboardingForm({ settings }: { settings: WorkspaceOnboardingSettings }) {
  const headingId = useId();
  const save = useServerFn(saveWorkspaceOnboarding);
  const queryClient = useQueryClient();
  const saved = welcomeKey(settings);
  const [welcome, setWelcome] = useState<WelcomeKey>(saved);
  const [greeting, setGreeting] = useState(settings.newAgentGreeting);
  const [saving, guard] = useSubmitGuard();
  const [saveError, setSaveError] = useState<SaveError | null>(null);
  useEffect(() => {
    setWelcome(saved);
    setGreeting(settings.newAgentGreeting);
  }, [saved, settings.newAgentGreeting]);
  const changed = welcome !== saved || greeting !== settings.newAgentGreeting;

  function submit() {
    void guard(async () => {
      setSaveError(null);
      const agentId = welcome.startsWith("agent:") ? welcome.slice("agent:".length) : null;
      try {
        const next = await save({
          data: {
            mode: agentId ? "agent" : (welcome as "assistant" | "off"),
            agentId,
            newAgentGreeting: greeting,
          },
        });
        queryClient.setQueryData(ONBOARDING_QUERY_KEY, next);
      } catch (cause) {
        setSaveError(saveErrorFrom(m.settings_save_error(), cause));
      }
    });
  }

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-4 py-6">
      <h2 id={headingId} className="text-lg font-semibold">
        {m.member_onboarding_title()}
      </h2>
      <div className="flex flex-col gap-6">
        <SettingsField
          label={m.member_onboarding_welcome()}
          description={m.member_onboarding_welcome_description()}
        >
          <Select
            aria-label={m.member_onboarding_welcome()}
            selectedKey={welcome}
            isDisabled={saving}
            onSelectionChange={(key) => {
              if (key !== null) setWelcome(String(key) as WelcomeKey);
            }}
          >
            <Select.Item id="assistant" label={m.member_onboarding_assistant()} />
            {settings.agents.map((agent) => (
              <Select.Item
                key={agent.id}
                id={`agent:${agent.id}`}
                label={agent.name}
                avatarUrl={agent.avatarUrl ?? undefined}
              />
            ))}
            <Select.Item id="off" label={m.member_onboarding_off()} />
          </Select>
        </SettingsField>
        <SettingsField
          inline
          label={m.member_onboarding_greeting()}
          description={m.member_onboarding_greeting_description()}
        >
          <Checkbox
            size="md"
            aria-label={m.member_onboarding_greeting()}
            isSelected={greeting}
            isDisabled={saving}
            onChange={setGreeting}
          />
        </SettingsField>
      </div>
      <SettingsCardFooter error={saveError}>
        <Button type="button" size="sm" isDisabled={saving || !changed} onPress={submit}>
          {saving ? m.settings_group_saving() : m.settings_group_save()}
        </Button>
      </SettingsCardFooter>
    </section>
  );
}
