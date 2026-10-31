import { useEffect, useRef, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { DotsHorizontal, Trash01 as Trash } from "@untitledui/icons";

import { PageHeader } from "#src/components/layout/page-header";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { m } from "#src/paraglide/messages";
import { ReportSectionEditor } from "#src/features/records/report-editor/report-section-editor";
import { readReportDraft, trackReportSave, writeReportDraft } from "./report-draft-cache";
import { deleteRecordNote, saveRecordNote } from "./records.functions";
import { BackToRecords } from "./records-layout";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { RecordsDeleteConfirmDialog } from "./records-delete-confirm-dialog";
import { RecordsReadingColumn } from "./records-reading-column";
import { fileToDataUrlUpload } from "./file-data-url-upload";
import type { NoteSubject } from "./record-subject";
import { useRecordDeleteDialog } from "./use-record-delete";

export function NoteDetail({ note }: { note: NoteSubject["note"] }) {
  const router = useRouter();
  const workspaceSlug = useWorkspaceSlug();
  const save = useServerFn(saveRecordNote);
  const remove = useServerFn(deleteRecordNote);
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
  const [deleting, setDeleting] = useState(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  async function persist(next: { title?: string; body?: string }, noteId = noteIdRef.current) {
    setSaving(true);
    try {
      writeReportDraft(noteId, { markdown: next.body ?? bodyRef.current });
      await trackReportSave(
        noteId,
        save({
          data: {
            noteId,
            title: next.title,
            body: next.body,
          },
        }),
      );
      void router.invalidate();
    } finally {
      setSaving(false);
    }
  }

  function schedulePersist(nextBody: string) {
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

  async function clearBody() {
    setBody("");
    bodyRef.current = "";
    writeReportDraft(noteIdRef.current, { markdown: "" });
    await persist({ body: "" });
  }

  async function removeNote() {
    setDeleting(true);
    deleteDialog.setError("");
    try {
      await remove({ data: { noteId: note.id } });
      deleteDialog.close();
      await router.invalidate({ sync: true });
      void router.navigate({
        to: "/w/$workspaceSlug/records",
        params: { workspaceSlug },
        search: { tab: "notes" },
      });
    } catch {
      deleteDialog.setError(m.records_delete_error());
    } finally {
      setDeleting(false);
    }
  }

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
      <RecordsDeleteConfirmDialog
        open={deleteDialog.open}
        title={m.records_note_delete_confirm_title({ name: title })}
        description={m.records_note_delete_confirm_body()}
        busy={deleting}
        error={deleteDialog.error}
        onOpenChange={deleteDialog.onOpenChange}
        onConfirm={() => void removeNote()}
      />
    </div>
  );
}
