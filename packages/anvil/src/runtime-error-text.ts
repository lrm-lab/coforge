import { redactCredentials } from "@lrm/coforge-sdk/internal";
import { truncateCodePoints } from "@lrm/coforge-sdk/internal";

/** The visible error-text cap shared by provider failures and daemon warning/activity formatting. */
const MAX_VISIBLE_ERROR_CHARS = 512;

/** Redacts and bounds provider error text before it becomes visible Activity. This is the single
 * implementation used by providers and daemon formatting, so secrets and the cap stay aligned. */
export function scrubRuntimeErrorText(message: string): string {
  return truncateCodePoints(redactCredentials(message), MAX_VISIBLE_ERROR_CHARS);
}
