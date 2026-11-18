import { expect, test } from "bun:test";
import {
  draftAttachments,
  finishUpload,
  removeDraftAttachments,
  startUpload,
  subscribeDraftAttachments,
  updateDraftAttachments,
  wasRemoved,
} from "#src/features/conversations/composer-attachment-drafts";
import type { PendingAttachment } from "#src/features/conversations/composer-attachments";

const pending = (localId: string): PendingAttachment => ({
  localId,
  file: new File(["x"], `${localId}.txt`),
  progress: 0,
});

test("each draft keeps its own files, and hears only its own changes", () => {
  const heard: string[] = [];
  const stopA = subscribeDraftAttachments("a", () => heard.push("a"));
  const stopB = subscribeDraftAttachments("b", () => heard.push("b"));
  updateDraftAttachments("a", (current) => [...current, pending("a1")]);
  expect(draftAttachments("a").map((item) => item.localId)).toEqual(["a1"]);
  expect(draftAttachments("b")).toEqual([]);
  expect(heard).toEqual(["a"]);
  updateDraftAttachments("a", () => []);
  expect(draftAttachments("a")).toBe(draftAttachments("never-used"));
  stopA();
  stopB();
});

test("an unchanged draft tells nobody", () => {
  let calls = 0;
  const stop = subscribeDraftAttachments("same", () => calls++);
  updateDraftAttachments("same", (current) => current);
  expect(calls).toBe(0);
  stop();
});

test("removing a file cancels its upload and keeps it from starting later", () => {
  updateDraftAttachments("c", () => [pending("c1"), pending("c2")]);
  const signal = startUpload("c1");
  removeDraftAttachments("c", ["c1", "c2"]);
  expect(signal.aborted).toBe(true);
  expect(wasRemoved("c2")).toBe(true);
  expect(draftAttachments("c")).toEqual([]);
  finishUpload("c1");
});

const patch = (key: string, localId: string, change: Partial<PendingAttachment>) =>
  updateDraftAttachments(key, (current) =>
    current.map((item) => (item.localId === localId ? { ...item, ...change } : item)),
  );

test("an upload that reports while no composer is mounted is there for the next one", () => {
  const stop = subscribeDraftAttachments("d", () => {});
  updateDraftAttachments("d", (current) => [...current, pending("d1")]);
  stop();
  patch("d", "d1", { progress: 40 });
  patch("d", "d1", { id: "server-d1", progress: 100 });
  let heard = 0;
  const again = subscribeDraftAttachments("d", () => heard++);
  expect(draftAttachments("d")).toEqual([{ ...pending("d1"), id: "server-d1", progress: 100 }]);
  expect(heard).toBe(0);
  again();
  updateDraftAttachments("d", () => []);
});

test("a sent draft is empty, and an upload finishing after the send does not bring its file back", () => {
  updateDraftAttachments("e", () => [pending("e1")]);
  updateDraftAttachments("e", () => []);
  expect(draftAttachments("e")).toEqual([]);
  patch("e", "e1", { id: "server-e1", progress: 100 });
  expect(draftAttachments("e")).toEqual([]);
});
