import { useEffect, useRef, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { DotsHorizontal, Trash01 as Trash } from "@untitledui/icons";

import { PageHeader } from "#src/components/layout/page-header";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { UNDO_TOAST_MS, useAppToast } from "#src/components/ui/toast";
import { m } from "#src/paraglide/messages";
import type { ContentEditorRef } from "#src/features/records/report-editor/content-editor";
import { ReportSectionEditor } from "#src/features/records/report-editor/report-section-editor";
import { readReportDraft, trackReportSave, writeReportDraft } from "./report-draft-cache";
import { deleteRecordNote, saveRecordNote } from "./records.functions";
import { BackToRecords } from "./records-layout";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { ConfirmDialog } from "#src/components/ui/confirm-dialog";
import { RecordsReadingColumn } from "./records-reading-column";
import { fileToDataUrlUpload } from "./file-data-url-upload";
import type { NoteSubject } from "./record-subject";
import { useRecordDeleteDialog } from "./use-record-delete";
import { useRecordRefresh } from "./use-record-refresh";

export function NoteDetail({ note }: { note: NoteSubject["note"] }) {
  const router = useRouter();
  const refresh = useRecordRefresh();
  const workspaceSlug = useWorkspaceSlug();
  const save = useServerFn(saveRecordNote);
  const remove = useServerFn(deleteRecordNote);
  const toast = useAppToast();
  const [title, setTitle] = useState(note.title);
  const [body, setBody] = useState(() => readReportDraft(note.id)?.markdown ?? note.body);
  const titleRef = useRef(title);
  const bodyRef = useRef(body);
  titleRef.current = title;
  bodyRef.current = body;
  const noteIdRef = useRef(note.id);
  noteIdRef.current = note.id;
  const [saving, setSaving] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const deleteDialog = useRecordDeleteDialog();
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const editorRef = useRef<ContentEditorRef>(null);
  /** The Undo toast for the last Clear, while it still applies. */
  const clearedToastRef = useRef<string>(undefined);

  /** Saves the note; resolves to whether the server took it. A failure is not thrown: autosaves
   * ignore it, a Clear and its Undo report it. */
  async function persist(
    next: { title?: string; body?: string },
    noteId = noteIdRef.current,
  ): Promise<boolean> {
    setSaving(true);
    try {
      writeReportDraft(noteId, { markdown: next.body ?? bodyRef.current });
      const request = save({
        data: {
          noteId,
          title: next.title,
          body: next.body,
        },
      });
      const saved = request.then(
        () => true,
        () => false,
      );
      await trackReportSave(noteId, request);
      void refresh.records();
      return await saved;
    } finally {
      setSaving(false);
    }
  }

  function dismissClearedToast() {
    if (clearedToastRef.current) toast.dismiss(clearedToastRef.current);
    clearedToastRef.current = undefined;
  }

  function schedulePersist(nextBody: string) {
    // Typing after a Clear ends its Undo: restoring would overwrite the new text.
    dismissClearedToast();
    setBody(nextBody);
    bodyRef.current = nextBody;
    writeReportDraft(noteIdRef.current, { markdown: nextBody });
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = undefined;
      void persist({ body: bodyRef.current });
    }, 900);
  }

  async function commitTitle() {
    const next = titleRef.current.trim();
    setEditingTitle(false);
    if (!next) {
      setTitle(note.title);
      titleRef.current = note.title;
      return;
    }
    if (next === note.title) return;
    setTitle(next);
    await persist({ title: next });
  }

  /** Replaces the whole body at once and saves it. The editor is told directly: once the user has
   * typed, it ignores a new `defaultValue`. Resolves to whether the save went through. */
  async function replaceBody(next: string): Promise<boolean> {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = undefined;
    editorRef.current?.setMarkdown(next);
    setBody(next);
    bodyRef.current = next;
    writeReportDraft(noteIdRef.current, { markdown: next });
    return persist({ body: next });
  }

  /** Clears the note at once and, once the save went through, offers Undo, which puts the cleared
   * text back unless something was typed since. */
  async function clearBody() {
    const previous = editorRef.current?.getMarkdown() ?? bodyRef.current;
    const title = m.records_note_cleared();
    // Registered before the save is awaited, so typing while it runs withdraws the Undo.
    if (previous) clearedToastRef.current = title;
    const saved = await replaceBody("");
    if (!previous) return;
    if (!saved) {
      if (clearedToastRef.current === title) clearedToastRef.current = undefined;
      return;
    }
    if (clearedToastRef.current !== title) return;
    toast.success(title, {
      durationMs: UNDO_TOAST_MS,
      action: {
        label: m.action_undo(),
        onClick: () => {
          // Text typed since is newer than what was cleared: restoring would overwrite it.
          if ((editorRef.current?.getMarkdown() ?? bodyRef.current) !== "") return;
          clearedToastRef.current = undefined;
          void replaceBody(previous).then((restored) => {
            if (!restored) toast.error(m.records_note_restore_failed());
          });
        },
      },
    });
  }

  async function removeNote() {
    await remove({ data: { noteId: note.id } });
    deleteDialog.close();
    await refresh.records();
    void router.navigate({
      to: "/w/$workspaceSlug/records",
      params: { workspaceSlug },
      search: { tab: "notes" },
    });
  }

  // Leaving the note ends its Undo: another view of the note may have been edited since.
  useEffect(() => {
    return () => {
      if (clearedToastRef.current) toast.dismiss(clearedToastRef.current);
    };
  }, [note.id, toast]);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = undefined;
      writeReportDraft(note.id, { markdown: bodyRef.current });
      trackReportSave(
        note.id,
        save({
          data: {
            noteId: note.id,
            title: titleRef.current.trim() || note.title,
            body: bodyRef.current,
          },
        }),
      );
    };
  }, [note.id, note.title, save]);

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <PageHeader
          heading={title}
          leading={<BackToRecords />}
          actions={
            <Dropdown.Root>
              <ButtonUtility
                size="sm"
                color="tertiary"
                icon={DotsHorizontal}
                aria-label={m.records_note_actions()}
                isDisabled={saving}
              />
              <Dropdown.Popover placement="bottom end" className="w-44">
                <Dropdown.Menu
                  onAction={(key) => {
                    if (key === "clear") void clearBody();
                    if (key === "delete") deleteDialog.request();
                  }}
                >
                  <Dropdown.Item id="clear" icon={Trash} label={m.records_report_clear()} />
                  <Dropdown.Item id="delete" icon={Trash} label={m.records_note_delete()} />
                </Dropdown.Menu>
              </Dropdown.Popover>
            </Dropdown.Root>
          }
        />

        <div className="min-h-0 flex-1 overflow-y-auto">
          <RecordsReadingColumn>
            {editingTitle ? (
              <input
                autoFocus
                value={title}
                aria-label={m.records_note_title()}
                onChange={(event) => {
                  const next = event.target.value;
                  setTitle(next);
                  titleRef.current = next;
                }}
                onBlur={() => void commitTitle()}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void commitTitle();
                  }
                  if (event.key === "Escape") {
                    setTitle(note.title);
                    titleRef.current = note.title;
                    setEditingTitle(false);
                  }
                }}
                className="mb-6 w-full bg-transparent text-display-sm font-semibold tracking-tight text-primary outline-none md:text-display-md"
              />
            ) : (
              <Button
                type="button"
                size="sm"
                color="tertiary"
                onPress={() => setEditingTitle(true)}
                className="mb-6 h-auto w-full justify-start px-0 py-0 text-left text-display-sm font-semibold tracking-tight text-primary md:text-display-md"
              >
                {title}
              </Button>
            )}
            <ReportSectionEditor
              key={note.id}
              editorRef={editorRef}
              defaultValue={body}
              placeholder={m.records_note_body_placeholder()}
              className="min-h-[55vh] pb-[45vh]"
              onUploadFile={fileToDataUrlUpload}
              onUpdate={(markdown) => {
                schedulePersist(markdown);
              }}
              onBlur={() => {
                if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
                void persist({ body: bodyRef.current });
              }}
            />
          </RecordsReadingColumn>
        </div>
      </div>
      <ConfirmDialog
        open={deleteDialog.open}
        onOpenChange={deleteDialog.setOpen}
        title={m.records_note_delete_confirm_title({ name: title })}
        description={m.records_note_delete_confirm_body()}
        confirmLabel={m.records_note_delete_action()}
        pendingLabel={m.records_delete_pending()}
        errorMessage={m.records_delete_error()}
        onConfirm={removeNote}
      />
    </div>
  );
}
