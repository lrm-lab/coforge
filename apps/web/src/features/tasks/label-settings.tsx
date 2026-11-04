import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ChevronDown, ChevronRight, Plus, SearchLg } from "@untitledui/icons";
import { useCallback, useState } from "react";

import { Button } from "#src/components/base/buttons/button";
import { Input } from "#src/components/base/input/input";
import { SettingsPage } from "#src/components/settings-layout";
import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import { workspaceConversationChannel } from "#src/features/conversations/conversation-realtime";
import { useRealtimeSubscription } from "#src/features/realtime/browser-realtime";
import { m } from "#src/paraglide/messages";

import { LabelColorSwatches } from "./label-color-swatches";
import { newLabelColor } from "./label-colors";
import { decodeLabelChangedEvent, decodeLabelGroupChangedEvent } from "./label-realtime";
import {
  LABEL_NAME_MAX_LENGTH,
  labelSections,
  nameTaken,
  type SettingsLabel,
} from "./label-settings-model";
import { LabelSettingsRow } from "./label-settings-row";
import { createTaskLabel, loadLabelSettings } from "./labels.functions";
import { workspaceLabelsKey } from "./workspace-labels";

const labelSettingsKey = (workspaceId: string) => ["label-settings", workspaceId];

/**
 * Settings → Labels (task #508, after Linear's Settings → Labels): every label of the Workspace,
 * searchable, by group, with how many Tasks carry each and when it was last used, and the archived
 * ones folded at the end. Any member reads the page and makes a label; an owner or admin renames,
 * recolors, describes, archives, restores and deletes them (the server checks every change). A
 * change made anywhere arrives as `label.changed.v1` and the list is read again.
 */
export function LabelSettings() {
  const workspaceId = useCurrentWorkspaceId() ?? "";
  const load = useServerFn(loadLabelSettings);
  const create = useServerFn(createTaskLabel);
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: labelSettingsKey(workspaceId),
    queryFn: () => load(),
    enabled: workspaceId !== "",
  });
  const refresh = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: labelSettingsKey(workspaceId) }),
      // The pickers' list follows a change made here.
      queryClient.invalidateQueries({ queryKey: workspaceLabelsKey(workspaceId) }),
    ]);
  }, [queryClient, workspaceId]);
  useRealtimeSubscription({
    channel: workspaceId ? workspaceConversationChannel(workspaceId) : undefined,
    onPublication: useCallback(
      ({ data }: { data: unknown }) => {
        if (decodeLabelChangedEvent(data) || decodeLabelGroupChangedEvent(data)) void refresh();
      },
      [refresh],
    ),
  });

  const [search, setSearch] = useState("");
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [color, setColor] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const labels: SettingsLabel[] = query.data?.labels ?? [];
  const canManage = query.data?.canManage ?? false;
  const { live, archived } = labelSections(labels, search);
  const wanted = name.trim();
  const pickedColor = color ?? newLabelColor(wanted);

  async function add() {
    if (!wanted) return;
    // The server answers an existing name with that label; say so instead of seeming to make one.
    if (nameTaken(labels, wanted))
      return setCreateError(m.labels_settings_name_taken({ name: wanted }));
    setCreateError(null);
    try {
      await create({ data: { name: wanted, color: pickedColor as never } });
      await refresh();
      setName("");
      setColor(null);
      setAdding(false);
    } catch {
      setCreateError(m.labels_settings_save_failed());
    }
  }

  const row = (label: SettingsLabel) => (
    <LabelSettingsRow
      key={label.id}
      label={label}
      labels={labels}
      canManage={canManage}
      onChanged={refresh}
    />
  );

  return (
    <SettingsPage>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <Input
            aria-label={m.labels_settings_search()}
            placeholder={m.labels_settings_search()}
            icon={SearchLg}
            size="sm"
            value={search}
            onChange={setSearch}
            wrapperClassName="sm:max-w-xs"
            className="flex-1"
          />
          {/* Gone while the form is open: its Create label is then the one primary button. */}
          {!adding && (
            <Button
              size="sm"
              iconLeading={Plus}
              className="sm:ml-auto"
              onPress={() => {
                setAdding(true);
                setCreateError(null);
              }}
            >
              {m.labels_settings_new()}
            </Button>
          )}
        </div>
        {!canManage && query.data && (
          <p className="text-sm text-tertiary">{m.labels_settings_members_note()}</p>
        )}

        {adding && (
          <div className="flex flex-col gap-3 rounded-xl border border-secondary p-4">
            <Input
              aria-label={m.labels_settings_new_name()}
              placeholder={m.labels_settings_new_name()}
              size="sm"
              value={name}
              maxLength={LABEL_NAME_MAX_LENGTH}
              autoFocus
              isInvalid={createError !== null}
              onChange={(next) => {
                setName(next);
                setCreateError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") void add();
                if (event.key === "Escape") setAdding(false);
              }}
            />
            <div className="w-fit">
              <LabelColorSwatches
                value={pickedColor}
                onChange={setColor}
                onSubmit={() => void add()}
              />
            </div>
            {createError && (
              <p role="alert" className="text-sm text-error-primary">
                {createError}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button color="tertiary" size="sm" onPress={() => setAdding(false)}>
                {m.labels_settings_cancel()}
              </Button>
              <Button size="sm" isDisabled={!wanted} onPress={() => void add()}>
                {m.labels_settings_create()}
              </Button>
            </div>
          </div>
        )}

        {query.isPending ? (
          <p className="text-sm text-tertiary">{m.labels_settings_loading()}</p>
        ) : query.isError ? (
          <div className="flex flex-col items-start gap-3">
            <p role="alert" className="text-sm text-error-primary">
              {m.labels_settings_load_failed()}
            </p>
            <Button color="secondary" size="sm" onPress={() => void query.refetch()}>
              {m.controls_retry()}
            </Button>
          </div>
        ) : live.length === 0 && archived.length === 0 ? (
          <p className="text-sm text-tertiary">
            {search.trim() ? m.labels_settings_no_match() : m.labels_settings_empty()}
          </p>
        ) : (
          <div className="overflow-hidden rounded-xl border border-secondary">
            {live.map((section) => (
              <section
                key={section.group ?? ""}
                aria-label={section.group ?? m.labels_settings_ungrouped()}
                className="border-b border-secondary last:border-b-0"
              >
                {section.group && (
                  <h3 className="bg-secondary px-4 py-2 text-xs font-semibold text-tertiary sm:px-5">
                    {section.group}
                  </h3>
                )}
                <ul className="divide-y divide-secondary">{section.labels.map(row)}</ul>
              </section>
            ))}
            {archived.length > 0 && (
              <section aria-label={m.labels_settings_archived({ count: String(archived.length) })}>
                <Button
                  color="tertiary"
                  size="sm"
                  aria-expanded={showArchived}
                  iconLeading={showArchived ? ChevronDown : ChevronRight}
                  onPress={() => setShowArchived((open) => !open)}
                  className="w-full justify-start rounded-none bg-secondary px-4 text-xs font-semibold text-tertiary sm:px-5"
                >
                  {m.labels_settings_archived({ count: String(archived.length) })}
                </Button>
                {showArchived && <ul className="divide-y divide-secondary">{archived.map(row)}</ul>}
              </section>
            )}
          </div>
        )}
      </div>
    </SettingsPage>
  );
}
