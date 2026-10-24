import { escapeXmlText } from "@lrm/coforge-sdk/internal";

/** What the launchd job writer escapes into a plist value: the same four entities, plus `'`, and a
 * refusal of the control characters XML 1.0 disallows. */
export function escapePlistValue(value: string): string {
  // XML 1.0 disallows these control characters, including NUL.
  // oxlint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) throw new Error("invalid plist value");
  return escapeXmlText(value).replaceAll("'", "&apos;");
}
