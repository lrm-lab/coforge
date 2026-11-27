import { useState } from "react";

import { Button } from "#src/components/base/buttons/button";
import { Checkbox } from "#src/components/base/checkbox/checkbox";
import { Alert } from "#src/components/ui/alert";
import { OptionCard, OptionCardGroup } from "#src/components/ui/option-card";
import { APP_FIXED_SCOPES } from "#src/features/apps/app-registration";
import { AppLogo } from "#src/features/apps/app-logo";
import { m } from "#src/paraglide/messages";
import { AgentAppsEmpty } from "./agent-apps-empty";
import type { AgentAppAccess } from "#src/features/agents/agent-apps.functions";

type InstalledApp = AgentAppAccess["apps"][number];

const FIXED: readonly string[] = APP_FIXED_SCOPES;

export function AgentAppGrantPanel({
  apps,
  anyInstalled,
  onCancel,
  onGrant,
}: {
  apps: InstalledApp[];
  anyInstalled: boolean;
  onCancel: () => void;
  onGrant: (appKey: string, scopes: string[]) => Promise<void>;
}) {
  const [appKey, setAppKey] = useState<string>();
  const [scopes, setScopes] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const app = apps.find((candidate) => candidate.key === appKey);

  const choose = (key: string) => {
    setAppKey(key);
    setScopes(apps.find((candidate) => candidate.key === key)?.allowedScopes ?? []);
  };
  const grant = async () => {
    if (!app) return;
    setSaving(true);
    setFailed(false);
    try {
      await onGrant(
        app.key,
        scopes.filter((scope) => !FIXED.includes(scope)),
      );
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-4 space-y-4 border-t border-secondary pt-4">
      <div>
        <p className="text-sm font-semibold text-primary">{m.agent_apps_grant_title()}</p>
        <p className="mt-0.5 text-sm text-tertiary">{m.agent_apps_grant_description()}</p>
      </div>
      {failed && <Alert color="error" description={m.agent_apps_grant_error()} />}
      {apps.length === 0 ? (
        anyInstalled ? (
          <AgentAppsEmpty title={m.agent_apps_grant_all_granted()} />
        ) : (
          <AgentAppsEmpty
            title={m.agent_apps_grant_no_apps()}
            description={m.agent_apps_grant_no_apps_description()}
          />
        )
      ) : (
        <OptionCardGroup
          aria-label={m.agent_apps_grant_app_label()}
          value={appKey ?? null}
          onChange={choose}
          isDisabled={saving}
        >
          {apps.map((candidate) => (
            <OptionCard
              key={candidate.key}
              value={candidate.key}
              label={
                <span className="flex min-w-0 items-center gap-2">
                  <AppLogo name={candidate.name} url={candidate.logoUrl} size="sm" />
                  <span className="min-w-0">{candidate.name}</span>
                </span>
              }
              description={
                candidate.description ? (
                  <span className="line-clamp-2">{candidate.description}</span>
                ) : undefined
              }
            />
          ))}
        </OptionCardGroup>
      )}
      {app && (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-secondary">
            {m.agent_apps_grant_scopes()}
          </legend>
          {app.allowedScopes.map((scope) => {
            const fixed = FIXED.includes(scope);
            return (
              <Checkbox
                key={scope}
                label={<span className="font-mono">{scope}</span>}
                hint={fixed ? m.agent_apps_grant_scope_fixed() : undefined}
                isSelected={fixed || scopes.includes(scope)}
                isDisabled={fixed || saving}
                onChange={(selected) =>
                  setScopes((current) =>
                    selected ? [...current, scope] : current.filter((s) => s !== scope),
                  )
                }
              />
            );
          })}
        </fieldset>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button size="sm" color="tertiary" onPress={onCancel} isDisabled={saving}>
          {m.agent_apps_grant_cancel()}
        </Button>
        <Button
          size="sm"
          color="primary"
          onPress={() => void grant()}
          isDisabled={!app || saving}
          isLoading={saving}
          showTextWhileLoading
        >
          {m.agent_apps_grant()}
        </Button>
      </div>
    </div>
  );
}
