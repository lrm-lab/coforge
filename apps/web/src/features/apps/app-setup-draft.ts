import {
  checkSetupInput,
  type AppSetupField,
  type AppSetupInput,
  type AppSetupSummary,
} from "./app-installation-setup";

/** The editor's setup fields as typed. */
export type SetupDraft = { required: boolean; url: string; description: string };

export const setupDraftOf = (setup: AppSetupSummary): SetupDraft => ({
  required: setup.url !== null,
  url: setup.url ?? "",
  description: setup.description,
});

/** What the draft sends: with setup off, no page and no instructions; else both trimmed. */
export const setupInputOf = (draft: SetupDraft): AppSetupInput =>
  draft.required
    ? { url: draft.url.trim(), description: draft.description.trim() }
    : { url: null, description: "" };

/** The fields the rules refuse in the draft. */
export function refusedSetupFields(draft: SetupDraft): AppSetupField[] {
  const checked = checkSetupInput(setupInputOf(draft));
  return checked.ok ? [] : [checked.field];
}
