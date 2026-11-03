import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

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
  const [saving, setSaving] = useState(false);
  const [readOnly, setReadOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [baseMoved, setBaseMoved] = useState(false);
  const [conflict, setConflict] = useState<ConflictResolution | null>(null);
  const [published, setPublished] = useState<PublishedVersion | null>(null);
  /** One key per save attempt: a retry of the same attempt reuses it, so it saves once. */
  const attemptKey = useRef<string | null>(null);
  /** The newest version announced while a save was in flight, handled once it has answered. */
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

  /** Shows the latest version in place of the one being edited (nothing is unsaved). */
  async function takeLatest() {
    const latest = await queryClient.fetchQuery({
      ...artifactDocumentQuery(artifactId),
      staleTime: 0,
    });
    setBase(latest.artifact.currentVersion);
    setSavedTitle(latest.artifact.title);
    setTitle(latest.artifact.title);
    setText(latest.text);
    editorRef.current?.setMarkdown(latest.text);
    touched.current = false;
    setDirty(false);
    setBaseMoved(false);
  }

  /** A version announced on the document's home: refresh what lists it, and take it in when
   * nothing is unsaved here. */
  function onPublished(version: PublishedVersion, { announce = true } = {}) {
    refreshArtifact(queryClient, artifactId);
    // A save of this page's own announces its version too, so while one is in flight the
    // announcement waits for its answer; someone else's later version is taken in after it.
    if (saving) {
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
  useEffect(() => {
    if (saving || !missed) return;
    setMissed(null);
    replayMissed(missed);
  }, [saving, missed]);

  /** Whether the person has acted on the text since it was read: the editor reports the text it
   * was given once it has laid it out, which is no edit. */
  const touched = useRef(false);
  function edit(next: { title?: string; text?: string }) {
    if (next.text !== undefined && next.title === undefined && !touched.current) return;
    if (next.title !== undefined) setTitle(next.title);
    if (next.text !== undefined) setText(next.text);
    setDirty(true);
    setError(null);
  }

  async function save() {
    if (base === null || saving || readOnly) return;
    const resolving = conflict;
    const body = resolving ? resolvedText(resolving) : (editorRef.current?.getMarkdown() ?? text);
    const settings = resolving ? resolvedSettings(resolving) : {};
    if (body === null || settings === null) return;
    const nextTitle = settings.title ?? (title.trim() || savedTitle);
    attemptKey.current ??= crypto.randomUUID();
    setSaving(true);
    setError(null);
    try {
      const saved = await saveArtifactDocument({
        data: {
          artifactId,
          baseVersion: resolving ? resolving.currentVersion : base,
          idempotencyKey: attemptKey.current,
          text: body,
          ...(nextTitle !== savedTitle ? { title: nextTitle } : {}),
        },
      });
      attemptKey.current = null;
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
      if (isAppError(cause) && cause.errorId === "artifact-base-moved") setBaseMoved(true);
      else if (isAppError(cause) && cause.code === "ACCESS_DENIED") setReadOnly(true);
      else
        setError(
          m.doc_save_failed({
            reason:
              isAppError(cause) && cause.errorId === "artifact-file-too-large"
                ? m.doc_save_too_large()
                : m.doc_save_error(),
          }),
        );
    } finally {
      setSaving(false);
    }
  }

  /** Drops what is unsaved and shows the latest version. */
  async function discard() {
    setConflict(null);
    setPublished(null);
    attemptKey.current = null;
    await takeLatest();
  }

  const status: ArtifactEditorStatus = readOnly
    ? "readOnly"
    : conflict
      ? "conflict"
      : saving
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
    touch: () => {
      touched.current = true;
    },
    save,
    discard,
    takeLatest,
    onPublished,
  };
}

export type ArtifactEditor = ReturnType<typeof useArtifactEditor>;
