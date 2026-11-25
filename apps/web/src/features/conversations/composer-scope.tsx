import { createContext, useContext } from "react";

/**
 * Where a composer keeps its draft and uploads its files, when that is not the conversation it
 * shows: a Task's discussion drafts under the Task, before its conversation exists and after, and
 * makes the conversation only once a file is about to be uploaded to it.
 */
export type ComposerScope = {
  draftKey?: string;
  uploadTo?: () => Promise<string>;
  placeholder?: string;
  composerPortal?: HTMLElement | null;
};

const ComposerScopeContext = createContext<ComposerScope | undefined>(undefined);

export const ComposerScopeProvider = ComposerScopeContext.Provider;

export function useComposerScope() {
  return useContext(ComposerScopeContext);
}
