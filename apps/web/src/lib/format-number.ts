import { getLocale } from "#src/paraglide/runtime";

const formats = new Map<string, Intl.NumberFormat>();

export function numberFormat(
  locale: string = getLocale(),
  options?: Intl.NumberFormatOptions,
): Intl.NumberFormat {
  const key = options ? `${locale}\u0000${JSON.stringify(options)}` : locale;
  let format = formats.get(key);
  if (!format) {
    format = new Intl.NumberFormat(locale, options);
    formats.set(key, format);
  }
  return format;
}

export function formatNumber(
  value: number,
  locale: string = getLocale(),
  options?: Intl.NumberFormatOptions,
): string {
  return numberFormat(locale, options).format(value);
}
