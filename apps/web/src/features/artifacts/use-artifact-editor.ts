import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { ContentEditorRef } from "#src/features/records/report-editor/content-editor";
import { isAppError } from "#src/lib/app-error";
import { m } from "#src/paraglide/messages";
import { saveArtifactDocument } from "./artifacts.functions";
import { AUTOSAVE_MS, canAutosave } from "./artifact-autosave";
import { keepingMine, type DocumentConflict } from "./artifact-conflict-model";
import { artifactDocumentQuery, refreshArtifact, type ArtifactActorRef } from "./artifact-queries";
import { nextSaveAttempt, type SaveAttempt } from "./artifact-save-attempt";

/** A version published on the document's home while it was open: someone else's, or a save of
 * this page's own. */
export type PublishedVersion = { number: number; publisher: ArtifactActorRef };

export type ArtifactEditorStatus = "saved" | "unsaved" | "saving" | "readOnly";

/** A save that keeps meeting a new conflict gives up after this many, until the next edit. */
const MAX_CONFLICT_RETRIES = 3;

type SavePayload = { baseVersion: number; text: string; title?: string; description?: string };

/**
 * The open document's editing (task #385): the version it was read at (`base`), the title and
 * text as edited, and a save over `base` that answers created (merged with what others saved
 * meanwhile), nothing, or a conflict, which saves again keeping the viewer's side (`keepingMine`).
 * Edits save by themselves once typing rests (`AUTOSAVE_MS`); typing goes on while a save is in
 * flight. A version someone else publishes is taken in at once when nothing is unsaved;
 * otherwise the next save merges it.
 */
export function useArtifactEditor(artifactId: string) {
  const queryClient = useQueryClient();
  const document = useQuery(artifactDocumentQuery(artifactId));
  const editorRef = useRef<ContentEditorRef>(null);
  const [base, setBase] = useState<number | null>(null);
  const [savedTitle, setSavedTitle] = useState("");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [dirty, setDirty] = useState(false);
  /** Counts the person's edits, so a pending save waits for typing to rest. */
  const [editTick, setEditTick] = useState(0);
  /** The last save gave up on conflicts it kept meeting: the next edit saves again. */
  const [stalled, setStalled] = useState(false);
  /** A save was refused: the viewer may no longer write here. */
  const [denied, setDenied] = useState(false);
  const [baseMoved, setBaseMoved] = useState(false);
  /** The last save that has not answered: only its exact retry reuses its key. */
  const attempt = useRef<SaveAttempt | null>(null);
  /** A save in flight, its failure, and a fresh start on the next edit (TanStack Query). */
  const saving = useMutation({
    mutationFn: (input: Parameters<typeof saveArtifactDocument>[0]["data"]) =>
      saveArtifactDocument({ data: input }),
  });
  /** The newest version announced while a save was in flight, handled once it has answered. */
  /** A save from its start until its version is shown (`saving` ends at the answer). */
  const [settling, setSettling] = useState(false);
  const [missed, setMissed] = useState<PublishedVersion | null>(null);

  const data = document.data;
  // Read only from the start where the read says the viewer may not write (task #529: a reader
  // through the Workspace level), or once a save was refused.
  const readOnly = denied || data?.artifact.canWrite === false;
  const entryPath = data?.artifact.entryPath ?? "document.md";
  // The first read sets what is being edited; later reads replace it only when nothing is
  // unsaved (`takeLatest`).
  useEffect(() => {
    if (!data || base !== null) return;
    setBase(data.artifact.currentVersion);
    setSavedTitle(data.artifact.title);
    setTitle(data.artifact.title);
    setText(data.text);
  }, [data, base]);

  /** Edits so far: an edit made while the latest version is read keeps that version out. */
  const edits = useRef(0);

  /**
   * Shows the latest version in place of the one being edited (nothing is unsaved). The read
   * takes a moment: if the person starts typing meanwhile, their text stays and the next save
   * merges the latest version, unless they asked to drop their edits (`force`).
   */
  async function takeLatest({ force = false } = {}) {
    const editsBefore = edits.current;
    const latest = await queryClient.fetchQuery({
      ...artifactDocumentQuery(artifactId),
      staleTime: 0,
    });
    if (!force && edits.current !== editsBefore) return;
    setBase(latest.artifact.currentVersion);
    setSavedTitle(latest.artifact.title);
    setTitle(latest.artifact.title);
    setText(latest.text);
    editorRef.current?.setMarkdown(latest.text);
    setDirty(false);
    setBaseMoved(false);
  }

  /** A version announced on the document's home: refresh what lists it, and take it in when
   * nothing is unsaved here. */
  function onPublished(version: PublishedVersion) {
    void refreshArtifact(queryClient, artifactId);
    // A save of this page's own announces its version too, so while one is in flight the
    // announcement waits for its answer; someone else's later version is taken in after it.
    if (settling) {
      setMissed((kept) => (version.number > (kept?.number ?? 0) ? version : kept));
      return;
    }
    if (base === null || version.number <= base) return;
    if (!dirty) void takeLatest();
  }

  // Once the save has answered (and its version is shown), the version announced meanwhile is
  // handled as any other: below the new base it is this save's own or already in it.
  const replayMissed = useEffectEvent((kept: NonNullable<typeof missed>) => onPublished(kept));
  // Once the save has settled - answered, and the version it made read in as the base - so the
  // announcement is weighed against that base.
  useEffect(() => {
    if (settling || !missed) return;
    setMissed(null);
    replayMissed(missed);
  }, [settling, missed]);

  /** The person changed the document: at once, while the text itself comes after the editor's
   * debounce (`ContentEditor` tells only of the person's edits). */
  function markEdited() {
    edits.current += 1;
    setEditTick(edits.current);
    setStalled(false);
    setDirty(true);
    if (saving.isError) saving.reset();
  }
  function edit(next: { title?: string; text?: string }) {
    if (next.title !== undefined) {
      setTitle(next.title);
      markEdited();
    }
    if (next.text !== undefined) setText(next.text);
  }

  /** Sends one save, its key kept for an exact retry of it. */
  async function send(payload: SavePayload) {
    attempt.current = nextSaveAttempt(attempt.current, payload);
    const saved = await saving.mutateAsync({
      artifactId,
      idempotencyKey: attempt.current.key,
      ...payload,
    });
    attempt.current = null;
    return saved;
  }

  /** Saves what is edited; true once nothing is left unsaved. */
  async function save(): Promise<boolean> {
    if (base === null || settling || readOnly) return false;
    const body = editorRef.current?.getMarkdown() ?? text;
    const nextTitle = title.trim() || savedTitle;
    let payload: SavePayload = {
      baseVersion: base,
      text: body,
      ...(nextTitle !== savedTitle ? { title: nextTitle } : {}),
    };
    const editsAtStart = edits.current;
    setSettling(true);
    try {
      let saved = await send(payload);
      // Someone else changed the same place meanwhile: the viewer's side stays, saved over their
      // version (again, should they save once more in between).
      let resolved = false;
      for (let tries = 0; saved.status === "conflict" && tries < MAX_CONFLICT_RETRIES; tries++) {
        const mine = keepingMine(saved as DocumentConflict, entryPath);
        payload = {
          baseVersion: mine.baseVersion,
          text: mine.text,
          ...(mine.settings.title !== undefined ? { title: mine.settings.title } : {}),
          ...(mine.settings.description !== undefined
            ? { description: mine.settings.description }
            : {}),
        };
        saved = await send(payload);
        resolved = true;
      }
      // Still racing: what is typed stays unsaved, and the next edit saves it again.
      const done = saved;
      if (done.status === "conflict") {
        setStalled(true);
        return false;
      }
      // Typed while the save was in flight: that stays unsaved, for the next save.
      const typedSince = edits.current !== editsAtStart;
      if (!typedSince) setDirty(false);
      if (done.status === "nothing") return !typedSince;
      void refreshArtifact(queryClient, artifactId);
      // A replayed save (this attempt already landed) says nothing of what it merged: read it.
      const mergedIn =
        resolved ||
        done.status !== "created" ||
        done.merged.length > 0 ||
        done.mergedSettings.length > 0;
      // What others saved meanwhile is in the new version: show it as saved. Text typed since
      // keeps the old base instead, so the next save merges it over that version again rather
      // than reading as the merged-in changes taken out.
      if (mergedIn) {
        if (!typedSince) await takeLatest();
      } else {
        setBase(done.number);
        setSavedTitle(nextTitle);
        if (!typedSince) setText(body);
      }
      return !typedSince;
    } catch (cause) {
      if (isBaseMoved(cause)) {
        setBaseMoved(true);
        void refreshArtifact(queryClient, artifactId);
      } else if (isWriteDenied(cause)) setDenied(true);
      return false;
    } finally {
      setSettling(false);
    }
  }

  /** Drops what is unsaved and shows the latest version. */
  async function discard() {
    attempt.current = null;
    saving.reset();
    await takeLatest({ force: true });
  }

  // Typing that rests saves by itself (`canAutosave`).
  const autosave = useEffectEvent(() => void save());
  const armed = canAutosave({
    dirty,
    loaded: base !== null,
    readOnly,
    saving: settling,
    failed: saving.isError,
    baseMoved,
    stalled,
  });
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(autosave, AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [armed, editTick, text, title]);

  const failure = saving.error;
  // A newer version or lost write access has its own banner, not a failure line.
  const error =
    !failure || isBaseMoved(failure) || isWriteDenied(failure)
      ? null
      : m.doc_save_failed({
          reason:
            isAppError(failure) && failure.errorId === "artifact-file-too-large"
              ? m.doc_save_too_large()
              : m.doc_save_error(),
        });

  const status: ArtifactEditorStatus = readOnly
    ? "readOnly"
    : saving.isPending
      ? "saving"
      : dirty
        ? "unsaved"
        : "saved";

  return {
    document,
    editorRef,
    base,
    title,
    text,
    dirty,
    status,
    /** A save is in flight or its version is still being read in: nothing is edited or picked
     * then, as it would not be in the save or would be replaced by what it reads. */
    busy: settling,
    error,
    baseMoved,
    edit,
    markEdited,
    save,
    discard,
    takeLatest,
    onPublished,
  };
}

export type ArtifactEditor = ReturnType<typeof useArtifactEditor>;

/** The save went over a version that is no longer the latest one the server can merge onto. */
const isBaseMoved = (cause: unknown) =>
  isAppError(cause) && cause.errorId === "artifact-base-moved";
/** The viewer may read the document but no longer write it. */
const isWriteDenied = (cause: unknown) => isAppError(cause) && cause.code === "ACCESS_DENIED";
