import { getLocale } from "#src/paraglide/runtime";

const formats = new Map<string, Intl.ListFormat>();

export function formatList(names: readonly string[]): string {
  const locale = getLocale();
  let format = formats.get(locale);
  if (!format) {
    format = new Intl.ListFormat(locale, { type: "conjunction" });
    formats.set(locale, format);
  }
  return format.format(names);
}
