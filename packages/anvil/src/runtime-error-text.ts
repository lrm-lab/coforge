import {
  MAX_VISIBLE_ERROR_CHARS,
  redactCredentials,
  truncateCodePoints,
} from "@lrm/coforge-sdk/internal";

/** Redacts and bounds provider error text before it becomes visible Activity. This is the single
 * implementation used by providers and daemon formatting, so secrets and the cap stay aligned. */
export function scrubRuntimeErrorText(message: string): string {
  return truncateCodePoints(redactCredentials(message), MAX_VISIBLE_ERROR_CHARS);
}
