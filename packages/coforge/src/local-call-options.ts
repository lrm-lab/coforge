import type { MentionSelectorInput as MentionSelector } from "@lrm/coforge-sdk/internal";
import type { MessageSearchOptions } from "./message-search-args";

/** Everything the local proxy `call` may add to its message request body. */
export type LocalCallOptions = MessageSearchOptions & {
  sendDraft?: boolean;
  expectedDraftKey?: string;
  continueAnyway?: boolean;
  continuationId?: string;
  continuationChoice?: "a" | "b" | "c" | "d";
  freshnessContextMode?: "withheld";
  around?: string;
  messageId?: string;
  emoji?: string;
  reason?: string;
  attachmentIds?: string[];
  mentions?: MentionSelector[];
  targetConfirmed?: boolean;
};
