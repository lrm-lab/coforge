import { getFileExtension } from "#src/features/files/file-meta";

/**
 * Which preview an attachment supports. Pure decision, kept out of the component so the rule that
 * governs it — above all the cross-origin requirement for a PDF — is testable on its own.
 */
export type AttachmentPreviewKind =
  | "markdown"
  | "html"
  | "text"
  | "csv"
  | "video"
  | "audio"
  | "pdf";

const MARKDOWN_EXTENSIONS = new Set(["md", "markdown", "mdown", "mkd"]);
const HTML_EXTENSIONS = new Set(["html", "htm"]);
/**
 * Plain-text files read literally, not as Markdown: a `.txt` must not turn `# line` into a heading.
 * Source code, configuration, data and logs read the same way, one numbered line each, so a
 * comment can point at their lines.
 */
const TEXT_EXTENSIONS = new Set([
  // Plain text and logs
  "txt",
  "text",
  "log",
  "out",
  "diff",
  "patch",
  // Data and configuration
  "json",
  "jsonl",
  "ndjson",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "properties",
  "xml",
  "tsv",
  "sql",
  "graphql",
  "gql",
  "proto",
  // Source code
  "ts",
  "tsx",
  "mts",
  "cts",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "kts",
  "scala",
  "swift",
  "c",
  "h",
  "cc",
  "cpp",
  "hpp",
  "cs",
  "php",
  "lua",
  "r",
  "dart",
  "pl",
  "sh",
  "bash",
  "zsh",
  "fish",
  "ps1",
  "css",
  "scss",
  "sass",
  "less",
  "vue",
  "svelte",
  "tf",
  "gradle",
]);
/** Content types read as plain text besides `text/*`. */
const TEXT_CONTENT_TYPES = new Set([
  "application/json",
  "application/x-ndjson",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/toml",
  "application/sql",
  "application/javascript",
  "application/typescript",
  "application/x-sh",
]);
const CSV_EXTENSIONS = new Set(["csv"]);

/**
 * The media types a `<video>`/`<audio>` element may be handed, and the exact MIME type used for
 * each. The element is fed a Blob built with one of these, so an attachment's bytes are never
 * sniffed into something else.
 */
export const MEDIA_TYPES = new Map<string, { kind: "video" | "audio"; mimeType: string }>([
  ["mp4", { kind: "video", mimeType: "video/mp4" }],
  ["m4v", { kind: "video", mimeType: "video/mp4" }],
  ["webm", { kind: "video", mimeType: "video/webm" }],
  ["ogv", { kind: "video", mimeType: "video/ogg" }],
  ["mp3", { kind: "audio", mimeType: "audio/mpeg" }],
  ["m4a", { kind: "audio", mimeType: "audio/mp4" }],
  ["wav", { kind: "audio", mimeType: "audio/wav" }],
  ["oga", { kind: "audio", mimeType: "audio/ogg" }],
  ["ogg", { kind: "audio", mimeType: "audio/ogg" }],
]);

/** The MIME type a previewable media attachment is played as, from our own allowlist. */
export function mediaMimeType(fileName: string): string | null {
  return MEDIA_TYPES.get(getFileExtension(fileName))?.mimeType ?? null;
}

/**
 * Whether `previewUrl` may be framed as a document.
 *
 * A PDF is read in the browser's own viewer, which cannot be sandboxed — an empty `sandbox`
 * blocks the viewer outright — so the only isolation left is the origin boundary: the document
 * must come from somewhere that holds none of this application's cookies. That requirement is
 * enforced here rather than described in a comment, and it fails closed: an absent, relative,
 * unparseable or same-origin URL is not previewable, and the attachment stays a download.
 *
 * `applicationOrigin` is the page's own origin, and an unknown origin is not previewable either.
 * During server rendering there is nothing to compare against, so a frame emitted there would be
 * decided by no check at all: the browser can begin loading `src` from the SSR HTML — with host
 * cookies, if the delivery origin is misconfigured to this one — before hydration re-runs this
 * function and removes it. A check that only runs after the frame exists is not fail-closed, so
 * the answer without a known origin is "no". Every caller renders inside the browser only (a
 * conversation is never server-rendered), which is why this costs no visible behaviour: the browser
 * always has an origin to compare.
 */
export function isFrameableDocumentUrl(
  previewUrl: string | undefined,
  applicationOrigin: string | undefined,
): boolean {
  if (!previewUrl || !applicationOrigin) return false;
  let url: URL;
  try {
    url = new URL(previewUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  return url.origin !== applicationOrigin;
}

/**
 * Which preview one attachment supports, or `null` for the rest (which stay download-only).
 *
 * The file name decides first: an upload's stored content type is whatever the sender's browser
 * guessed, and a `.md` file routinely arrives as `text/plain` or `application/octet-stream`.
 */
export function attachmentPreviewKind(
  fileName: string,
  contentType: string,
  /** The signed delivery URL, when the server supplied one. Required for a PDF, and only when it
   * is genuinely off this origin — see `isFrameableDocumentUrl`. */
  previewUrl?: string,
  /** The page's own origin; absent during server rendering. */
  applicationOrigin: string | undefined = globalThis.location?.origin,
): AttachmentPreviewKind | null {
  const extension = getFileExtension(fileName);
  if (extension === "pdf" || contentType === "application/pdf")
    return isFrameableDocumentUrl(previewUrl, applicationOrigin) ? "pdf" : null;
  if (MARKDOWN_EXTENSIONS.has(extension)) return "markdown";
  if (HTML_EXTENSIONS.has(extension)) return "html";
  // A `.ts` file usually arrives as `video/mp2t`, the MIME table's entry for an MPEG transport
  // stream, even when it is TypeScript; the bytes tell the two apart (`isTextContent`).
  if (TEXT_EXTENSIONS.has(extension)) return "text";
  if (CSV_EXTENSIONS.has(extension)) return "csv";
  const media = MEDIA_TYPES.get(extension);
  if (media) return media.kind;
  if (contentType === "text/markdown") return "markdown";
  if (contentType === "text/html") return "html";
  if (contentType === "text/csv") return "csv";
  if (contentType.startsWith("text/") || TEXT_CONTENT_TYPES.has(contentType)) return "text";
  return null;
}

/** How much of a file `isTextContent` reads: enough to meet a binary format's header and tables. */
const TEXT_SNIFF_BYTES = 8 * 1024;

/**
 * Whether a file named as text really holds text: its first bytes are valid UTF-8 and carry no NUL.
 * A binary file under a text name (an MPEG transport stream saved as `.ts`, a mislabelled upload)
 * fails both at once. Only the head is checked, so one stray byte deep inside an older log does not
 * keep the whole file from previewing.
 */
export function isTextContent(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, TEXT_SNIFF_BYTES);
  if (head.includes(0)) return false;
  try {
    // `stream` lets a multi-byte character cut by the end of the head pass as incomplete.
    new TextDecoder("utf-8", { fatal: true }).decode(head, { stream: true });
    return true;
  } catch {
    return false;
  }
}
