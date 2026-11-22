import { useEffect, useId, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { CircleAlert } from "kubai-icons/duotone";
import { Button } from "#src/components/base/buttons/button";
import { Checkbox } from "#src/components/base/checkbox/checkbox";
import { Select } from "#src/components/base/select/select";
import { SettingsCardFooter, SettingsField } from "#src/components/settings-layout";
import { EmptyState, RetryButton } from "#src/components/ui/empty";
import { EmptyIcon } from "#src/components/ui/empty-icon";
import { saveErrorFrom, type SaveError } from "#src/components/save-error";
import { useSubmitGuard } from "#src/hooks/use-submit-guard";
import { m } from "#src/paraglide/messages";
import {
  loadWorkspaceOnboarding,
  saveWorkspaceOnboarding,
  type WorkspaceOnboardingSettings,
} from "./onboarding.functions";

const ONBOARDING_QUERY_KEY = ["settings-member-onboarding"];

type WelcomeKey = "assistant" | "off" | `agent:${string}`;

function welcomeKey(settings: Pick<WorkspaceOnboardingSettings, "mode" | "agentId">): WelcomeKey {
  return settings.mode === "agent" && settings.agentId
    ? `agent:${settings.agentId}`
    : settings.mode === "off"
      ? "off"
      : "assistant";
}

export function MemberOnboardingSettings() {
  const load = useServerFn(loadWorkspaceOnboarding);
  const query = useQuery({ queryKey: ONBOARDING_QUERY_KEY, queryFn: () => load() });
  if (query.isPending) return null;
  if (query.isError) {
    return (
      <EmptyState
        size="card"
        role="alert"
        className="my-6"
        picture={<EmptyIcon icon={CircleAlert} size="card" />}
        title={m.member_onboarding_load_error()}
        primaryAction={
          <RetryButton
            size="card"
            isRetrying={query.isRefetching}
            onPress={() => void query.refetch()}
          />
        }
      />
    );
  }
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
