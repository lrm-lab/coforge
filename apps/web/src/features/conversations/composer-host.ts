import { createContext, useContext, type ReactNode, type RefObject } from "react";

import { useStandaloneThread } from "./standalone-thread";

/**
 * What the page hosting a conversation asks of the composer it hosts: whether opening the
 * conversation puts the caret there (`autoFocus`), what floats on the composer's top edge beside
 * the Agents' line (`overhead`), and a ref the composer's field registers itself in
 * (`composerRef`), so the host can put the caret there and tell when it is. Activity keeps the
 * caret in its list and names its keys there; everywhere else the composer takes the caret, with
 * nothing over it.
 */
export type ComposerHost = {
  autoFocus: boolean;
  overhead?: ReactNode;
  composerRef?: RefObject<HTMLTextAreaElement | null>;
};

const UNHOSTED: ComposerHost = { autoFocus: true };

export const ComposerHostContext = createContext<ComposerHost>(UNHOSTED);

/**
 * The host's asks of one pane's composer. They reach only the composer the host shows: the
 * conversation's, or the thread's when the thread is shown alone; a thread opened beside the
 * conversation, or a Task popup over it, keeps the usual composer.
 */
export function useComposerHost(rootId: string | undefined, inTaskPopup: boolean): ComposerHost {
  const host = useContext(ComposerHostContext);
  const standalone = useStandaloneThread();
  const hosted = !inTaskPopup && (rootId === undefined || standalone?.rootId === rootId);
  return hosted ? host : UNHOSTED;
}
