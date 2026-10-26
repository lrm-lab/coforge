import {
  ACTIVITY_SUBAGENT_TYPE_MAX,
  codePointLength,
  truncateCodePoints,
} from "@lrm/coforge-sdk/internal";
import { collapseWhitespace } from "#src/inline-text";

/**
 * A provider's subagent type as Activity shows it, on a lineage or a progress row: control
 * characters and whitespace runs collapsed to one space, at most `ACTIVITY_SUBAGENT_TYPE_MAX`
 * code points (ellipsis included); `undefined` when nothing printable remains.
 */
export function subagentTypeLabel(type: unknown): string | undefined {
  if (typeof type !== "string") return undefined;
  const text = collapseWhitespace(type.replace(/[\x00-\x1f\x7f]/g, " "));
  if (!text) return undefined;
  return codePointLength(text) <= ACTIVITY_SUBAGENT_TYPE_MAX
    ? text
    : `${truncateCodePoints(text, ACTIVITY_SUBAGENT_TYPE_MAX - 1)}…`;
}
