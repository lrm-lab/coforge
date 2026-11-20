import type { ArtifactCheckFindings, ArtifactCheckShot } from "@lrm/coforge-sdk/agent";

type LogLevel = "info" | "warn" | "error";

export type ArtifactCheckLogEntry = Record<string, unknown> & {
  event: string;
};

export type ArtifactCheckLogger = {
  info(entry: ArtifactCheckLogEntry): void;
  warn(entry: ArtifactCheckLogEntry): void;
  error(entry: ArtifactCheckLogEntry): void;
};

function emit(level: LogLevel, entry: ArtifactCheckLogEntry): void {
  const payload = JSON.stringify({
    ...entry,
    ts: new Date().toISOString(),
  });
  if (level === "error") console.error(payload);
  else if (level === "warn") console.warn(payload);
  else console.info(payload);
}

export const defaultArtifactCheckLogger: ArtifactCheckLogger = {
  info: (entry) => emit("info", entry),
  warn: (entry) => emit("warn", entry),
  error: (entry) => emit("error", entry),
};

export function summarizeFindings(findings: ArtifactCheckFindings) {
  return {
    consoleErrorCount: findings.consoleErrors.length,
    blockedResourceCount: findings.blockedResources.length,
    blank: findings.blank,
    phoneOverflow: findings.phoneOverflow !== null,
    phoneOverflowPx: findings.phoneOverflow
      ? findings.phoneOverflow.contentWidth - findings.phoneOverflow.viewportWidth
      : 0,
    inlineClipped: findings.inlineOverflow?.clipped ?? false,
    inlineHeightPx: findings.inlineOverflow?.contentHeight ?? null,
    pageCantScrollCount: findings.pageCantScroll?.length ?? 0,
  };
}

export function summarizeShots(shots: readonly { shot: ArtifactCheckShot; sizeBytes: number }[]): {
  shotCount: number;
  totalShotBytes: number;
  shots: Record<string, number>;
} {
  let totalShotBytes = 0;
  const byShot: Record<string, number> = {};
  for (const item of shots) {
    totalShotBytes += item.sizeBytes;
    byShot[item.shot] = item.sizeBytes;
  }
  return { shotCount: shots.length, totalShotBytes, shots: byShot };
}
