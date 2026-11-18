export type ComposerSendState = {
  hydrated: boolean;
  uploading: boolean;
  anyFailed: boolean;
  hasContent: boolean;
};

export function composerSendDisabled({ hydrated, anyFailed, hasContent }: ComposerSendState) {
  return !hydrated || anyFailed || !hasContent;
}

export function composerSendPress(state: ComposerSendState): "ignored" | "after-uploads" | "now" {
  if (composerSendDisabled(state)) return "ignored";
  return state.uploading ? "after-uploads" : "now";
}

export function composerUploadsSettled({
  waiting,
  uploading,
  anyFailed,
}: {
  waiting: boolean;
  uploading: boolean;
  anyFailed: boolean;
}): "idle" | "waiting" | "send" | "cancel" {
  if (!waiting) return "idle";
  if (uploading) return "waiting";
  return anyFailed ? "cancel" : "send";
}
