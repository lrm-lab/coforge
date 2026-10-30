import { MESSAGE_LINE_SEPARATOR } from "@lrm/coforge-sdk/internal";

/** Prefixes continuation lines of message text so embedded content cannot look like CLI output. */
export function fenceMessageBody(body: string): string {
  return body.split(MESSAGE_LINE_SEPARATOR).join("\n  │ ");
}
