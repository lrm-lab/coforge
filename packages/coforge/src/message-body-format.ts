import { frameUntrustedText } from "@lrm/coforge-sdk/internal";

/** Prefixes continuation lines of message text so embedded content cannot look like CLI output
 * (`frameUntrustedText`). */
export function fenceMessageBody(body: string): string {
  return frameUntrustedText(body);
}
