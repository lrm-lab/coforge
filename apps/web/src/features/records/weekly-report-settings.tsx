import { ChevronLeft, Edit01 as Edit, Plus, Trash01 as Trash } from "@untitledui/icons";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";

import { Tab, TabList, TabPanel, Tabs } from "#src/components/application/tabs/tabs";
import { Button } from "#src/components/base/buttons/button";
import { EmptyState } from "#src/components/ui/empty";
import { RecordsWireframe } from "#src/components/ui/empty-wireframes";
import { edgeFadeStyle, TAB_BAR_END_FADE_WIDTH, useScrollEdges } from "#src/hooks/use-scroll-edges";
import { m } from "#src/paraglide/messages";
import { CreateWeeklyTemplateDialog } from "./create-weekly-template-dialog";
import { KeyPointPromptEditor } from "./key-point-prompt-editor";
import { ConfirmDialog } from "#src/components/ui/confirm-dialog";
import {
  emptyKeyPointPrompts,
  formatRecipientSummary,
  keyPointHistoryIndexOf,
  type KeyPointPromptHistoryEntry,
  type KeyPointPromptsMeta,
} from "./records-content";
import { WeeklyTemplateDetailDialog } from "./weekly-template-detail-dialog";
import { weekdayLabel, type TemplateMemberOption } from "./weekly-template-members";
import {
  applyWeeklyTemplate,
  createWeeklyTemplate,
  deleteKeyPointPromptHistory,
  deleteWeeklyTemplate,
  saveKeyPointPrompts,
  updateWeeklyTemplate,
  type loadKeyPointPrompts,
  type loadWeeklyTemplates,
} from "./records.functions";
import { BackToRecords } from "./records-layout";
import { useRecordRefresh } from "./use-record-refresh";

export type WeeklyTemplateList = Awaited<ReturnType<typeof loadWeeklyTemplates>>;
export type KeyPointPromptsSnapshot = Awaited<ReturnType<typeof loadKeyPointPrompts>>;

export type { TemplateMemberOption };

type SettingsTopTab = "templates" | "key_points";
type KeyPointSlot = "team" | "personal";

function recipientsCell(template: WeeklyTemplateList[number]) {
  if (template.allMembers) return m.records_template_all_members();
  return formatRecipientSummary(template.recipients.map((row) => row.displayName));
}

export function WeeklyReportSettings({
  templates,
  members,
  keyPointPrompts,
  openCreateOnMount = false,
  initialSection,
  initialSlot,
  returnTo,
}: {
  templates: WeeklyTemplateList;
  members: TemplateMemberOption[];
  keyPointPrompts: KeyPointPromptsSnapshot;
  openCreateOnMount?: boolean;
  initialSection?: SettingsTopTab;
  initialSlot?: KeyPointSlot;
  returnTo?: string;
}) {
  const router = useRouter();
  const refresh = useRecordRefresh();
  const navigate = useNavigate({ from: "/w/$workspaceSlug/records/settings" });
  const create = useServerFn(createWeeklyTemplate);
  const update = useServerFn(updateWeeklyTemplate);
  const apply = useServerFn(applyWeeklyTemplate);
  const remove = useServerFn(deleteWeeklyTemplate);
  const savePrompts = useServerFn(saveKeyPointPrompts);
  const deleteHistory = useServerFn(deleteKeyPointPromptHistory);
  const resolvedSlot: KeyPointSlot = initialSlot ?? "personal";
  const [topTab, setTopTab] = useState<SettingsTopTab>(initialSection ?? "templates");
  const [keyPointSlot, setKeyPointSlot] = useState<KeyPointSlot>(resolvedSlot);
  const initialPrompts = keyPointPrompts ?? emptyKeyPointPrompts();
  const [prompts, setPrompts] = useState<KeyPointPromptsMeta>(initialPrompts);
  const [draftText, setDraftText] = useState(initialPrompts[resolvedSlot].text);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const templatesRef = useRef<HTMLDivElement>(null);
  const editingRef = useRef(false);
  const appliedServerTextRef = useRef(initialPrompts[resolvedSlot].text);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<WeeklyTemplateList[number] | null>(null);
  const [detail, setDetail] = useState<WeeklyTemplateList[number] | null>(null);
  const [deletingTemplate, setDeletingTemplate] = useState<WeeklyTemplateList[number] | null>(null);
  const [busy, setBusy] = useState(false);
  const topTabsFade = useScrollEdges("x", { observe: '[role="tab"]' });

  function readEditorText(): string {
    return textareaRef.current?.value ?? draftText;
  }

  function applyServerPrompts(next: KeyPointPromptsMeta, slot: KeyPointSlot = keyPointSlot) {
    const text = next[slot].text;
    setPrompts(next);
    appliedServerTextRef.current = text;
    setDraftText(text);
    if (textareaRef.current && textareaRef.current.value !== text) {
      textareaRef.current.value = text;
    }
  }

  useEffect(() => {
    const next = keyPointPrompts ?? emptyKeyPointPrompts();
    setPrompts(next);
    if (editingRef.current) return;
    const serverText = next[keyPointSlot].text;
    if (serverText === appliedServerTextRef.current && serverText === draftText) return;
    applyServerPrompts(next, keyPointSlot);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- slot changes handled in selectKeyPointSlot
  }, [keyPointPrompts]);

  function selectKeyPointSlot(slot: KeyPointSlot) {
    editingRef.current = false;
    setKeyPointSlot(slot);
    applyServerPrompts(prompts, slot);
  }

  function openCreate() {
    setEditing(null);
    setDialogOpen(true);
  }

  function openEdit(template: WeeklyTemplateList[number]) {
    setDetail(null);
    setEditing(template);
    setDialogOpen(true);
  }

  useEffect(() => {
    if (!openCreateOnMount) return;
    setTopTab("templates");
    setEditing(null);
    setDialogOpen(true);
    void navigate({
      replace: true,
      search: (previous) => ({
        tab: previous.tab === "notes" ? "notes" : "weekly",
        create: undefined,
      }),
    });
  }, [openCreateOnMount, navigate]);

  async function toggleApplied(template: WeeklyTemplateList[number]) {
    if (busy) return;
    setBusy(true);
    try {
      await apply({ data: { templateId: template.id } });
      await refresh.records();
    } finally {
      setBusy(false);
    }
  }

  async function deleteTemplate(template: WeeklyTemplateList[number]) {
    await remove({ data: { templateId: template.id } });
    if (detail?.id === template.id) setDetail(null);
    await refresh.records();
  }

  async function onSavePrompt() {
    if (busy) return;
    const textToSave = readEditorText();
    editingRef.current = false;
    setDraftText(textToSave);
    setBusy(true);
    try {
      const saved = await savePrompts({
        data: { slot: keyPointSlot, text: textToSave },
      });
      applyServerPrompts(saved, keyPointSlot);
      await refresh.records();
      applyServerPrompts(saved, keyPointSlot);
    } finally {
      setBusy(false);
    }
  }

  async function deleteHistoryEntry(entry: KeyPointPromptHistoryEntry) {
    const historyIndex = keyPointHistoryIndexOf(prompts[keyPointSlot].history, entry);
    if (historyIndex < 0) return;
    const saved = await deleteHistory({ data: { slot: keyPointSlot, historyIndex } });
    setPrompts(saved);
    await refresh.records();
    setPrompts(saved);
  }

  const activePrompt = prompts[keyPointSlot];

  return (
    <>
      <Tabs
        selectedKey={topTab}
        onSelectionChange={(key) => {
          if (key === "templates" || key === "key_points") setTopTab(key);
        }}
        className="min-h-0 flex-1"
      >
        <div className="flex h-12 shrink-0 items-center gap-3 border-b border-secondary px-page">
          {returnTo ? (
            <Button
              size="sm"
              color="link-color"
              iconLeading={ChevronLeft}
              className="*:data-icon:rtl:rotate-180 any-pointer-coarse:min-h-11"
              onPress={() => {
                void router.navigate({ href: returnTo });
              }}
            >
              {m.records_key_points_back_to_report()}
            </Button>
          ) : (
            <BackToRecords />
          )}
          <div
            ref={topTabsFade.ref}
            style={edgeFadeStyle(
              { start: false, end: topTabsFade.end },
              { end: TAB_BAR_END_FADE_WIDTH },
            )}
            className="scrollbar-hide -mb-px flex min-w-0 flex-1 self-end overflow-x-auto overflow-y-hidden scroll-pe-14"
          >
            <TabList
              aria-label={m.records_settings()}
              type="underline"
              className="w-max shrink-0 gap-4 before:hidden"
            >
              <Tab id="templates">{m.records_settings_tab_templates()}</Tab>
              <Tab id="key_points">{m.records_settings_tab_key_points()}</Tab>
            </TabList>
          </div>
          {topTab === "templates" ? (
            <Button size="sm" color="primary" iconLeading={Plus} onPress={openCreate}>
              {m.records_create_template()}
            </Button>
          ) : (
            <Button size="sm" color="primary" isDisabled={busy} onPress={() => void onSavePrompt()}>
              {m.records_key_points_prompt_save()}
            </Button>
          )}
        </div>

        <TabPanel
          id="templates"
          className="min-h-0 flex-1 overflow-auto bg-primary px-page py-4 sm:py-6"
        >
          <div ref={templatesRef} tabIndex={-1} className="outline-hidden">
            {templates.length === 0 ? (
              <EmptyState
                className="py-10"
                picture={<RecordsWireframe accent />}
                title={m.empty_records_templates_title()}
                description={m.empty_records_templates_description()}
                primaryAction={
                  <Button size="sm" color="primary" iconLeading={Plus} onPress={openCreate}>
                    {m.records_create_template()}
                  </Button>
                }
              />
            ) : (
              <div className="overflow-x-auto rounded-xl border border-secondary">
                <table className="w-full min-w-[52rem] border-collapse text-start text-sm text-primary">
                  <thead>
                    <tr className="bg-secondary_subtle text-tertiary">
                      <th className="px-4 py-3 font-medium">{m.records_template_name()}</th>
                      <th className="px-4 py-3 font-medium">{m.records_template_recipients()}</th>
                      <th className="px-4 py-3 font-medium whitespace-nowrap">
                        {m.records_template_frequency()}
                      </th>
                      <th className="px-4 py-3 font-medium whitespace-nowrap">
                        {m.records_template_send_time()}
                      </th>
                      <th className="px-4 py-3 font-medium whitespace-nowrap">
                        {m.records_template_enabled()}
                      </th>
                      <th className="px-4 py-3 font-medium whitespace-nowrap">
                        {m.records_template_actions()}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {templates.map((template) => (
                      <tr
                        key={template.id}
                        className="cursor-pointer border-t border-secondary hover:bg-primary_hover"
                        onClick={() => setDetail(template)}
                      >
                        <td className="max-w-[20rem] px-4 py-3">
                          <Button
                            size="sm"
                            color="link-gray"
                            aria-label={`${m.records_template_open_detail()}: ${template.name}`}
                            onPress={() => setDetail(template)}
                            className="h-auto max-w-[20rem] justify-start text-start font-medium whitespace-normal wrap-anywhere text-primary *:data-text:whitespace-normal *:data-text:wrap-anywhere"
                          >
                            {template.name}
                          </Button>
                        </td>
                        <td className="px-4 py-3 text-secondary">{recipientsCell(template)}</td>
                        <td className="px-4 py-3 whitespace-nowrap text-secondary">
                          {m.records_template_frequency_weekly()}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-secondary">
                          {m.records_template_send_on({
                            weekday: weekdayLabel(template.sendWeekday),
                            time: template.sendTime,
                          })}
                        </td>
                        <td
                          className="px-4 py-3 whitespace-nowrap"
                          onClick={(event) => event.stopPropagation()}
                        >
                          <Button
                            size="sm"
                            color="link-gray"
                            isDisabled={busy}
                            className="any-pointer-coarse:min-h-11 any-pointer-coarse:min-w-11 any-pointer-coarse:justify-center any-pointer-coarse:px-2"
                            onPress={() => void toggleApplied(template)}
                          >
                            {template.active
                              ? m.records_template_enabled_yes()
                              : m.records_template_enabled_no()}
                          </Button>
                        </td>
                        <td
                          className="px-4 py-3 whitespace-nowrap"
                          onClick={(event) => event.stopPropagation()}
                        >
                          <div className="flex items-center gap-3">
                            <Button
                              size="sm"
                              color="link-color"
                              iconLeading={Edit}
                              isDisabled={busy}
                              className="any-pointer-coarse:min-h-11 any-pointer-coarse:px-2"
                              onPress={() => openEdit(template)}
                            >
                              {m.records_template_edit()}
                            </Button>
                            <Button
                              size="sm"
                              color="tertiary-destructive"
                              iconLeading={Trash}
                              isDisabled={busy}
                              className="any-pointer-coarse:min-h-11 any-pointer-coarse:px-2"
                              onPress={() => setDeletingTemplate(template)}
                            >
                              {m.records_template_delete()}
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </TabPanel>
        <TabPanel id="key_points" className="flex min-h-0 flex-1 flex-col bg-primary">
          <Tabs
            selectedKey={keyPointSlot}
            onSelectionChange={(key) => {
              if (key === "team" || key === "personal") selectKeyPointSlot(key);
            }}
            className="min-h-0 flex-1"
          >
            <TabList
              aria-label={m.records_settings_tab_key_points()}
              type="underline"
              className="shrink-0 gap-4 px-4 pt-3 sm:px-8"
            >
              <Tab id="team">{m.records_key_points_slot_team()}</Tab>
              <Tab id="personal">{m.records_key_points_slot_personal()}</Tab>
            </TabList>
            <TabPanel id={keyPointSlot} className="flex min-h-0 flex-1 flex-col">
              <KeyPointPromptEditor
                prompt={activePrompt}
                text={draftText}
                busy={busy}
                textareaRef={textareaRef}
                onChange={(text) => {
                  editingRef.current = true;
                  setDraftText(text);
                }}
                onFocus={() => {
                  editingRef.current = true;
                }}
                onBlur={() => {
                  editingRef.current = false;
                  setDraftText(readEditorText());
                }}
                onDeleteHistory={deleteHistoryEntry}
              />
            </TabPanel>
          </Tabs>
        </TabPanel>
      </Tabs>

      <ConfirmDialog
        open={deletingTemplate !== null}
        onOpenChange={(open) => {
          if (!open) setDeletingTemplate(null);
        }}
        title={m.records_template_delete_confirm_title({
          name: deletingTemplate?.name ?? "",
        })}
        description={m.records_template_delete_confirm_body()}
        confirmLabel={m.records_template_delete_action()}
        pendingLabel={m.records_delete_pending()}
        errorMessage={m.records_delete_error()}
        onConfirm={async () => {
          if (!deletingTemplate) return;
          await deleteTemplate(deletingTemplate);
          setDeletingTemplate(null);
          templatesRef.current?.focus({ preventScroll: true });
        }}
      />

      <WeeklyTemplateDetailDialog
        template={detail}
        members={members}
        onClose={() => setDetail(null)}
      />

      <CreateWeeklyTemplateDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) setEditing(null);
        }}
        members={members}
        initial={editing}
        onSave={async (input) => {
          setBusy(true);
          try {
            if (editing) {
              await update({ data: { templateId: editing.id, ...input } });
            } else {
              await create({ data: input });
            }
            await refresh.records();
          } finally {
            setBusy(false);
          }
        }}
      />
    </>
  );
}
