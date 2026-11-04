import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { ContentEditorRef } from "#src/features/records/report-editor/content-editor";
import { isAppError } from "#src/lib/app-error";
import { m } from "#src/paraglide/messages";
import { saveArtifactDocument } from "./artifacts.functions";
import {
  resolutionOf,
  resolvedSettings,
  resolvedText,
  type ConflictResolution,
  type DocumentConflict,
} from "./artifact-conflict-model";
import { artifactDocumentQuery, refreshArtifact, type ArtifactActorRef } from "./artifact-queries";
import { nextSaveAttempt, type SaveAttempt } from "./artifact-save-attempt";

/** A version someone else published while the document was open. */
export type PublishedVersion = { number: number; publisher: ArtifactActorRef };

export type ArtifactEditorStatus = "saved" | "unsaved" | "saving" | "conflict" | "readOnly";

/**
 * The open document's editing (task #385): the version it was read at (`base`), the title and
 * text as edited, and a save over `base` that answers created (merged with what others saved
 * meanwhile), nothing, or a conflict, which the page resolves and saves over the latest version.
 * A version someone else publishes is taken in at once when nothing is unsaved; otherwise the
 * next save merges it.
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
  const [readOnly, setReadOnly] = useState(false);
  const [baseMoved, setBaseMoved] = useState(false);
  const [conflict, setConflict] = useState<ConflictResolution | null>(null);
  const [published, setPublished] = useState<PublishedVersion | null>(null);
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
  const [missed, setMissed] = useState<{ version: PublishedVersion; announce: boolean } | null>(
    null,
  );

  const data = document.data;
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
  function onPublished(version: PublishedVersion, { announce = true } = {}) {
    refreshArtifact(queryClient, artifactId);
    // A save of this page's own announces its version too, so while one is in flight the
    // announcement waits for its answer; someone else's later version is taken in after it.
    if (settling) {
      setMissed((kept) =>
        version.number > (kept?.version.number ?? 0) ? { version, announce } : kept,
      );
      return;
    }
    if (base === null || version.number <= base) return;
    if (announce || dirty || conflict) setPublished(version);
    if (!dirty && !conflict) void takeLatest();
  }

  // Once the save has answered (and its version is shown), the version announced meanwhile is
  // handled as any other: below the new base it is this save's own or already in it.
  const replayMissed = useEffectEvent((kept: NonNullable<typeof missed>) =>
    onPublished(kept.version, { announce: kept.announce }),
  );
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

  async function save() {
    if (base === null || saving.isPending || readOnly) return;
    const resolving = conflict;
    const body = resolving ? resolvedText(resolving) : (editorRef.current?.getMarkdown() ?? text);
    const settings = resolving ? resolvedSettings(resolving) : {};
    if (body === null || settings === null) return;
    const nextTitle = settings.title ?? (title.trim() || savedTitle);
    const payload = {
      baseVersion: resolving ? resolving.currentVersion : base,
      text: body,
      ...(nextTitle !== savedTitle ? { title: nextTitle } : {}),
      // A description conflict's pick (the page does not edit the description otherwise).
      ...(settings.description !== undefined ? { description: settings.description } : {}),
    };
    attempt.current = nextSaveAttempt(attempt.current, payload);
    setSettling(true);
    try {
      const saved = await saving.mutateAsync({
        artifactId,
        idempotencyKey: attempt.current.key,
        ...payload,
      });
      attempt.current = null;
      if (saved.status === "conflict") {
        setConflict(resolutionOf(saved as DocumentConflict, entryPath, resolving ?? undefined));
        return;
      }
      setConflict(null);
      setPublished(null);
      setDirty(false);
      if (saved.status === "nothing") {
        // A resolution that matches the latest version is saved already: show that version.
        if (resolving) await takeLatest();
        return;
      }
      refreshArtifact(queryClient, artifactId);
      // A replayed save (this attempt already landed) says nothing of what it merged: read it.
      const mergedIn =
        saved.status !== "created" || saved.merged.length > 0 || saved.mergedSettings.length > 0;
      // What others saved meanwhile is in the new version: show it as saved.
      if (mergedIn || resolving) await takeLatest();
      else {
        setBase(saved.number);
        setSavedTitle(nextTitle);
        setText(body);
      }
    } catch (cause) {
      if (isBaseMoved(cause)) {
        setBaseMoved(true);
        // The banner's confirmation names the latest version.
        refreshArtifact(queryClient, artifactId);
      } else if (isWriteDenied(cause)) setReadOnly(true);
    } finally {
      setSettling(false);
    }
  }

  /** Drops what is unsaved and shows the latest version. */
  async function discard() {
    setConflict(null);
    setPublished(null);
    attempt.current = null;
    saving.reset();
    await takeLatest({ force: true });
  }

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
    : conflict
      ? "conflict"
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
    dirty: dirty || conflict !== null,
    status,
    error,
    baseMoved,
    conflict,
    setConflict,
    published,
    dismissPublished: () => setPublished(null),
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
