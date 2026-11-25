import { formatNumber } from "#src/lib/format-number";

const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

export function formatWorkspaceSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const formatted =
    unit === 0
      ? formatNumber(Math.round(value))
      : formatNumber(value, undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return `${formatted} ${UNITS[unit]}`;
}
