export const ARTIFACT_CHECK_SHOTS = ["desktop", "phone", "inline", "inline-dark"] as const;
export type ArtifactCheckShot = (typeof ARTIFACT_CHECK_SHOTS)[number];

export const ARTIFACT_CHECK_STATUSES = ["pending", "running", "done", "failed", "skipped"] as const;
export type ArtifactCheckStatus = (typeof ARTIFACT_CHECK_STATUSES)[number];

export type ArtifactCheckViewport = {
  readonly shot: ArtifactCheckShot;
  readonly width: number;
  readonly height: number;
  readonly deviceScaleFactor: number;
  readonly mobile: boolean;
};

export const ARTIFACT_CHECK_VIEWPORTS: readonly ArtifactCheckViewport[] = [
  { shot: "desktop", width: 1280, height: 800, deviceScaleFactor: 1, mobile: false },
  { shot: "phone", width: 390, height: 844, deviceScaleFactor: 2, mobile: true },
  { shot: "inline", width: 896, height: 800, deviceScaleFactor: 1, mobile: false },
  { shot: "inline-dark", width: 896, height: 800, deviceScaleFactor: 1, mobile: false },
];

export const ARTIFACT_CHECK_MAX_CONSOLE_ERRORS = 10;
export const ARTIFACT_CHECK_MAX_BLOCKED_RESOURCES = 20;
export const ARTIFACT_CHECK_MAX_BROKEN_IMAGES = 10;
export const ARTIFACT_CHECK_MAX_FAILED_ASSETS = 10;
export const ARTIFACT_CHECK_SHOT_MAX_BYTES = 5 * 1024 * 1024;
export const ARTIFACT_CHECK_REPORT_MAX_BYTES = 64 * 1024;
export const ARTIFACT_CHECK_RETENTION_VERSIONS = 3;
export const ARTIFACT_CHECK_INLINE_MAX_HEIGHT_PX = 800;

export type ArtifactCheckConsoleError = {
  message: string;
  source: string | null;
  line: number | null;
};

export type ArtifactCheckPhoneOverflow = {
  contentWidth: number;
  viewportWidth: number;
};

export type ArtifactCheckInlineOverflow = {
  contentHeight: number;
  maxHeight: number;
  clipped: boolean;
};

export type ArtifactCheckScrollLock = {
  shot: ArtifactCheckShot;
  viewportWidth: number;
  viewportHeight: number;
  contentHeight: number;
  hiddenHeight: number;
  heldBy: { element: string; style: string }[];
};

export type ArtifactCheckFindings = {
  consoleErrors: ArtifactCheckConsoleError[];
  blockedResources: string[];
  blank: boolean;
  phoneOverflow: ArtifactCheckPhoneOverflow | null;
  inlineOverflow?: ArtifactCheckInlineOverflow | null;
  pageCantScroll?: ArtifactCheckScrollLock[];
  brokenImages?: string[];
  failedAssets?: string[];
};

export type ArtifactCheckScreenshotRef = {
  shot: ArtifactCheckShot;
  sizeBytes?: number;
};

export type ArtifactCheckRecord = {
  id: string;
  status: ArtifactCheckStatus;
  skipReason: string | null;
  errorClass: string | null;
  findings: ArtifactCheckFindings | null;
  durationMs: number | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  screenshots: ArtifactCheckScreenshotRef[];
};

export type ArtifactCheckResponse = {
  artifact: {
    id: string;
    title: string;
    currentVersion: number;
  };
  version: number;
  checksEnabled: boolean;
  check: ArtifactCheckRecord | null;
};

export type ArtifactCheckShotResponse = {
  artifactId: string;
  version: number;
  shot: ArtifactCheckShot;
  contentType: string;
  sizeBytes: number;
  data: string;
};

export function isArtifactCheckShot(value: unknown): value is ArtifactCheckShot {
  return typeof value === "string" && (ARTIFACT_CHECK_SHOTS as readonly string[]).includes(value);
}

export function isArtifactCheckStatus(value: unknown): value is ArtifactCheckStatus {
  return (
    typeof value === "string" && (ARTIFACT_CHECK_STATUSES as readonly string[]).includes(value)
  );
}
