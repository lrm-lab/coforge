import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useState } from "react";

import { Button } from "#src/components/base/buttons/button";
import { Checkbox } from "#src/components/base/checkbox/checkbox";
import { RadioButton, RadioGroup } from "#src/components/base/radio-buttons/radio-buttons";
import { Alert } from "#src/components/ui/alert";
import { m } from "#src/paraglide/messages";
import type { AgentAccessMode, AgentAccessScopeView } from "./agent-access-scope";
import { loadAppAgentAccessScope, setAppAgentAccessScope } from "./agent-access-scope.functions";

/**
 * Which Agents may use an installed app (`AgentAccessMode`). Every role reads it ("Available to all
 * Agents" / "Available to N Agents"); an owner or admin (`canManage`) also chooses All Agents or
 * Selected Agents and the Agents, and Save applies at once (the last write wins). It revokes no
 * existing grant: owners revoke those on the Agent's Apps tab.
 */
export function AgentAccessScope({
  appKey,
  canManage,
  showTitle = true,
}: {
  appKey: string;
  canManage: boolean;
  /** False where the surrounding section already carries the title. */
  showTitle?: boolean;
}) {
  const load = useServerFn(loadAppAgentAccessScope);
  const setScope = useServerFn(setAppAgentAccessScope);
  const [view, setView] = useState<AgentAccessScopeView>();
  const [mode, setMode] = useState<AgentAccessMode>("all");
  const [selected, setSelected] = useState<string[]>([]);
  const [problem, setProblem] = useState<"load" | "save" | null>(null);
  const [saving, setSaving] = useState(false);

  const applyView = useCallback((next: AgentAccessScopeView) => {
    setView(next);
    setMode(next.mode);
    setSelected(next.agentIds ?? []);
  }, []);

  useEffect(() => {
    let current = true;
    setView(undefined);
    setProblem(null);
    load({ data: { key: appKey } }).then(
      (next) => current && applyView(next),
      () => current && setProblem("load"),
    );
    return () => {
      current = false;
    };
  }, [appKey, load, applyView]);

  async function save() {
    setSaving(true);
    setProblem(null);
    try {
      applyView(await setScope({ data: { key: appKey, mode, agentIds: selected } }));
    } catch {
      setProblem("save");
    } finally {
      setSaving(false);
    }
  }

  const changed =
    view !== undefined &&
    (mode !== view.mode ||
      (mode === "selected" &&
        (selected.length !== view.agentIds?.length ||
          selected.some((id) => !view.agentIds?.includes(id)))));

  return (
    <section className="grid gap-2">
      {showTitle && (
        <h3 className="text-sm font-semibold text-primary">{m.apps_agent_access_title()}</h3>
      )}
      {problem === "load" && <Alert color="warning" title={m.apps_agent_access_load_error()} />}
      {!view && problem !== "load" && (
        <p className="text-sm text-tertiary">{m.apps_agent_access_loading()}</p>
      )}
      {view && !canManage && (
        <p className="text-sm text-secondary">
          {view.count === null
            ? m.apps_agent_access_all_summary()
            : m.apps_agent_access_selected_summary({ count: view.count })}
        </p>
      )}
      {view && canManage && (
        <div className="grid gap-3 rounded-xl border border-secondary p-4">
          <RadioGroup
            aria-label={m.apps_agent_access_title()}
            value={mode}
            onChange={(next) => setMode(next === "selected" ? "selected" : "all")}
            isDisabled={saving}
            className="gap-3"
          >
            <RadioButton
              value="all"
              label={m.apps_agent_access_all()}
              hint={m.apps_agent_access_all_hint()}
            />
            <RadioButton
              value="selected"
              label={m.apps_agent_access_selected()}
              hint={m.apps_agent_access_selected_hint()}
            />
          </RadioGroup>
          {mode === "selected" && (
            <fieldset className="grid max-h-56 gap-2 overflow-y-auto rounded-lg border border-secondary p-3">
              <legend className="px-1 text-sm text-tertiary">
                {m.apps_agent_access_pick({ count: selected.length })}
              </legend>
              {(view.candidates ?? []).length === 0 && (
                <p className="text-sm text-tertiary">{m.apps_agent_access_no_agents()}</p>
              )}
              {(view.candidates ?? []).map((agent) => (
                <Checkbox
                  key={agent.id}
                  label={agent.name}
                  isDisabled={saving}
                  isSelected={selected.includes(agent.id)}
                  onChange={(on) =>
                    setSelected((now) =>
                      on ? [...now, agent.id] : now.filter((id) => id !== agent.id),
                    )
                  }
                />
              ))}
            </fieldset>
          )}
          {mode === "selected" && selected.length === 0 && (
            <Alert color="warning" title={m.apps_agent_access_none_selected()} />
          )}
          <p className="text-sm text-tertiary">{m.apps_agent_access_grants_kept()}</p>
          {problem === "save" && <Alert color="error" title={m.apps_agent_access_save_error()} />}
          <div className="flex justify-end">
            <Button
              type="button"
              size="sm"
              color="primary"
              isDisabled={!changed || saving}
              isLoading={saving}
              showTextWhileLoading
              onPress={() => void save()}
            >
              {saving ? m.apps_agent_access_saving() : m.apps_agent_access_save()}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
