const listFormats = new Map<string, Intl.ListFormat>();
const numberFormats = new Map<string, Intl.NumberFormat>();

export function listFormat(
  locale: string,
  options: Intl.ListFormatOptions = { type: "conjunction" },
): Intl.ListFormat {
  const key = `${locale}\u0000${JSON.stringify(options)}`;
  let formatter = listFormats.get(key);
  if (!formatter) {
    formatter = new Intl.ListFormat(locale, options);
    listFormats.set(key, formatter);
  }
  return formatter;
}

export function numberFormat(
  locale: string,
  options?: Intl.NumberFormatOptions,
): Intl.NumberFormat {
  const key = options ? `${locale}\u0000${JSON.stringify(options)}` : locale;
  let formatter = numberFormats.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, options);
    numberFormats.set(key, formatter);
  }
  return formatter;
}
