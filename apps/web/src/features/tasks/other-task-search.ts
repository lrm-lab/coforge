import { useRouter, useSearch } from "@tanstack/react-router";
import { useCallback } from "react";
import { z } from "zod";

/** A Task of a conversation other than the one on screen. */
export type OtherTask = { kind: "channel" | "dm"; conversationId: string; number: number };

const OTHER_TASK_PARAM = /^(channel|dm):([0-9a-f-]{36}):([1-9]\d*)$/i;

/** The Workspace layout's `otherTask` search param, `channel:<id>:<number>` or `dm:<id>:<number>`:
 * the Task popup open over whatever page is showing (`OtherTaskPopup`). A page's own `task` param
 * means a Task of that page, so it cannot say this. */
export const otherTaskParamSchema = z.string().regex(OTHER_TASK_PARAM).optional().catch(undefined);

export function otherTaskParam({ kind, conversationId, number }: OtherTask) {
  return `${kind}:${conversationId}:${number}`;
}

export function parseOtherTask(param: string | undefined): OtherTask | undefined {
  const match = param === undefined ? null : OTHER_TASK_PARAM.exec(param);
  if (!match) return undefined;
  const [, kind, conversationId, number] = match;
  return {
    kind: kind as OtherTask["kind"],
    conversationId: conversationId!,
    number: Number(number),
  };
}

/** The param as the loose `to: "."` navigation sees it, on any page of the Workspace. */
type OtherTaskSearch = { otherTask?: string };

/** The open `otherTask` param, as written. */
export function useOtherTaskParam() {
  return useSearch({
    strict: false,
    select: (search: OtherTaskSearch) => search.otherTask,
  });
}

/**
 * Opens a Task of another conversation over the page, which stays where it is. Like a
 * conversation's own popup (`useOpenConversationTask`), opening pushes a history entry so browser
 * Back closes the popup, and closing replaces in place.
 */
export function useOpenOtherTask() {
  const router = useRouter();
  const open = useCallback(
    (task: OtherTask) =>
      void router.navigate({
        to: ".",
        resetScroll: false,
        search: (previous: OtherTaskSearch) => ({ ...previous, otherTask: otherTaskParam(task) }),
      }),
    [router],
  );
  const close = useCallback(
    () =>
      void router.navigate({
        to: ".",
        replace: true,
        resetScroll: false,
        search: ({ otherTask: _otherTask, ...rest }: OtherTaskSearch) => rest,
      }),
    [router],
  );
  return { open, close };
}
