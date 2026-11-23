export type ComposerSendState = {
  hydrated: boolean;
  uploading: boolean;
  anyFailed: boolean;
  hasContent: boolean;
  waiting?: boolean;
};

export function composerSendDisabled({
  hydrated,
  anyFailed,
  hasContent,
  waiting = false,
}: ComposerSendState) {
  return !hydrated || anyFailed || !hasContent || waiting;
}

export function composerSendPress(state: ComposerSendState): "ignored" | "after-uploads" | "now" {
  if (composerSendDisabled(state)) return "ignored";
  return state.uploading ? "after-uploads" : "now";
}

export function composerUploadsSettled({
  waitingDraftKey,
  draftKey,
  uploading,
  anyFailed,
}: {
  waitingDraftKey: string | null;
  draftKey: string;
  uploading: boolean;
  anyFailed: boolean;
}): "idle" | "waiting" | "send" | "cancel" {
  if (waitingDraftKey === null) return "idle";
  if (waitingDraftKey !== draftKey) return "cancel";
  if (anyFailed) return "cancel";
  return uploading ? "waiting" : "send";
}
