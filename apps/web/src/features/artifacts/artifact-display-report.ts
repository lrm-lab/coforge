import { useCallback, useRef, useState } from "react";

import type { ComposerPrefill, DisplayReportRequest } from "./artifact-commenting";

export type DisplayReportInput = {
  version: number;
  width?: number | null | undefined;
  height?: number | null | undefined;
  pixelRatio?: number | null | undefined;
  userAgent?: string | null | undefined;
};

function detectBrowser(userAgent: string): string | null {
  const edge = /Edg(?:A|iOS)?\/(\d+)/.exec(userAgent);
  if (edge) return `Edge ${edge[1]}`;
  const opera = /OPR\/(\d+)/.exec(userAgent);
  if (opera) return `Opera ${opera[1]}`;
  const firefox = /(?:Firefox|FxiOS)\/(\d+)/.exec(userAgent);
  if (firefox) return `Firefox ${firefox[1]}`;
  const chrome = /(?:Chrome|CriOS)\/(\d+)/.exec(userAgent);
  if (chrome) return `Chrome ${chrome[1]}`;
  const safariVersion = /Version\/(\d+(?:\.\d+)?)/.exec(userAgent);
  if (/Safari\//.test(userAgent) && safariVersion) return `Safari ${safariVersion[1]}`;
  if (/Safari\//.test(userAgent)) return "Safari";
  return null;
}

function detectOs(userAgent: string): string | null {
  if (/iPhone|iPad|iPod/.test(userAgent)) return "iOS";
  if (/Android/.test(userAgent)) return "Android";
  if (/CrOS/.test(userAgent)) return "ChromeOS";
  if (/Macintosh|Mac OS X/.test(userAgent)) return "macOS";
  if (/Windows/.test(userAgent)) return "Windows";
  if (/Linux/.test(userAgent)) return "Linux";
  return null;
}

export function parseBrowserSummary(userAgent: string): string {
  const trimmed = userAgent.trim();
  if (!trimmed) return "Unknown";
  const parts = [detectBrowser(trimmed), detectOs(trimmed)].filter(
    (part): part is string => part !== null,
  );
  return parts.length > 0 ? parts.join(", ") : "Unknown";
}

function positiveDimension(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : null;
}

function formatPixelRatio(value: number | null | undefined): string {
  const ratio =
    typeof value === "number" && Number.isFinite(value) && value > 0
      ? value
      : typeof window !== "undefined" &&
          Number.isFinite(window.devicePixelRatio) &&
          window.devicePixelRatio > 0
        ? window.devicePixelRatio
        : 1;
  const rounded = Number(ratio.toFixed(2));
  return `${rounded}x`;
}

export function buildDisplayReportText(input: DisplayReportInput): string {
  const fallbackWidth = typeof window !== "undefined" ? window.innerWidth : null;
  const fallbackHeight = typeof window !== "undefined" ? window.innerHeight : null;
  const width = positiveDimension(input.width ?? fallbackWidth);
  const height = positiveDimension(input.height ?? fallbackHeight);
  const pixelRatio = formatPixelRatio(input.pixelRatio);
  const userAgent =
    input.userAgent !== undefined
      ? (input.userAgent ?? "")
      : typeof navigator !== "undefined"
        ? navigator.userAgent
        : "";
  const lines = ["Display report from CoForge's viewer:", `Version: v${input.version}`];
  if (width !== null && height !== null) {
    lines.push(`Page area: ${width}x${height} CSS px, Pixel ratio: ${pixelRatio}`);
  } else {
    lines.push(`Pixel ratio: ${pixelRatio}`);
  }
  lines.push(`Browser: ${parseBrowserSummary(userAgent)}`);
  return lines.join("\n");
}

export function useDisplayReportPrefill(openComments: () => void, shownVersion: number) {
  const nextId = useRef(0);
  const [prefill, setPrefill] = useState<ComposerPrefill | null>(null);

  const requestDisplayReport = useCallback(
    (input?: DisplayReportRequest) => {
      const text = buildDisplayReportText({
        version: input?.version ?? shownVersion,
        width: input?.width,
        height: input?.height,
      });
      nextId.current += 1;
      setPrefill({ id: nextId.current, text });
      openComments();
    },
    [openComments, shownVersion],
  );

  const consumePrefill = useCallback(() => {
    setPrefill(null);
  }, []);

  return { prefill, consumePrefill, requestDisplayReport };
}
