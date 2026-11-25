const numberFormatCache = new Map<string, Intl.NumberFormat>();

function cachedNumberFormat(
  key: string,
  locale: string,
  options?: Intl.NumberFormatOptions,
): Intl.NumberFormat {
  const existing = numberFormatCache.get(key);
  if (existing) return existing;
  const created = new Intl.NumberFormat(locale, options);
  if (numberFormatCache.size >= 32) numberFormatCache.clear();
  numberFormatCache.set(key, created);
  return created;
}

export function formatCompactTokens(value: number, locale: string): string {
  const safe = Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
  if (safe < 10_000) return cachedNumberFormat(`exact:${locale}`, locale).format(safe);
  return cachedNumberFormat(`compact:${locale}`, locale, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(safe);
}

export function formatExactTokens(value: number, locale: string): string {
  const safe = Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
  return cachedNumberFormat(`exact:${locale}`, locale).format(safe);
}

export function formatUsagePercent(value: number, locale: string): string {
  return cachedNumberFormat(`pct:${locale}`, locale, {
    style: "percent",
    maximumFractionDigits: 1,
  }).format(value / 100);
}

export function heatmapLevel(value: number, peak: number): 0 | 1 | 2 | 3 | 4 {
  if (value <= 0 || peak <= 0) return 0;
  const ratio = value / peak;
  if (ratio <= 0.25) return 1;
  if (ratio <= 0.5) return 2;
  if (ratio <= 0.75) return 3;
  return 4;
}
