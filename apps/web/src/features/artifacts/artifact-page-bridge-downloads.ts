import {
  BridgeRefusal,
  INVALID_PARAMS,
  REFUSED,
  requireText,
  type CallTable,
} from "./artifact-page-bridge-core";
import { PAGE_DOWNLOAD_MAX_BYTES } from "./artifact-page-limits";

const UNSAFE_ASCII = new Set(["/", "\\", "<", ">", ":", '"', "|", "?", "*"]);

function isUnsafeChar(char: string): boolean {
  if (UNSAFE_ASCII.has(char)) return true;
  const code = char.codePointAt(0) ?? 0;
  return (
    code <= 0x1f ||
    code === 0x7f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

export function sanitizeDownloadName(raw: string): string | null {
  const cleaned = Array.from(raw.trim(), (char) => (isUnsafeChar(char) ? "-" : char))
    .join("")
    .replace(/^\.+/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return cleaned.length > 0 ? cleaned : null;
}

export function createDownloadCalls(host: {
  userActive(): boolean;
  downloadFile(file: Blob, name: string): void;
}): CallTable {
  return {
    "downloads.save": (args) => {
      if (!host.userActive())
        throw new BridgeRefusal(REFUSED, "Download needs a click in the page");
      const raw = args.file;
      let blob: Blob;
      if (raw instanceof Blob) {
        blob = raw;
      } else if (typeof raw === "string") {
        blob = new Blob([raw], { type: "text/plain;charset=utf-8" });
      } else {
        throw new BridgeRefusal(INVALID_PARAMS, "A Blob or string expected");
      }
      if (blob.size === 0 || blob.size > PAGE_DOWNLOAD_MAX_BYTES)
        throw new BridgeRefusal(INVALID_PARAMS, "A file of up to 25 MiB expected");
      const rawName = requireText(
        args.name ?? (raw instanceof File ? raw.name : undefined),
        "A file name",
        200,
      );
      const name = sanitizeDownloadName(rawName);
      if (!name) throw new BridgeRefusal(INVALID_PARAMS, "A valid file name expected");
      host.downloadFile(blob, name);
      return { saved: true, name, sizeBytes: blob.size };
    },
  };
}
