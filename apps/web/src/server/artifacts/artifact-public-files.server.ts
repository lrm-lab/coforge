import type { ArtifactPathKind } from "#src/features/artifacts/artifact-path-kind";
import { parseCsv } from "#src/features/artifacts/artifact-csv";
import { m } from "#src/paraglide/messages";
import {
  escapeHtml,
  publicReadingPage,
  publicReadingResponse,
} from "./artifact-public-markdown.server";

const DRAWN_LIMITS: Partial<Record<ArtifactPathKind, number>> = {
  text: 1024 * 1024,
  csv: 1024 * 1024,
  image: 8 * 1024 * 1024,
};

const CSV_CELLS_DRAWN = 50_000;

export function publicFileDrawn(kind: ArtifactPathKind, sizeBytes: number): boolean {
  const limit = DRAWN_LIMITS[kind];
  return limit !== undefined && sizeBytes <= limit;
}

type PublicFileRequest = {
  method: string;
  title: string;
  acceptLanguage: string | null;
  frameAncestor?: string;
};

export function publicImagePage(input: PublicFileRequest & { path: string }): Response {
  const name = input.path.slice(input.path.lastIndexOf("/") + 1);
  return publicReadingResponse(
    input.method,
    publicReadingPage({
      title: input.title,
      body: `${heading(input.title)}<figure><img src="${escapeHtml(
        encodeURIComponent(name),
      )}" alt="${escapeHtml(input.title)}"></figure>`,
    }),
    "'self'",
    input.frameAncestor,
  );
}

export function publicTextPage(
  input: PublicFileRequest & { kind: ArtifactPathKind; bytes: Uint8Array },
): Response {
  const text = new TextDecoder().decode(input.bytes);
  const drawn = input.kind === "csv" ? csvTable(text) : `<pre>${escapeHtml(text)}</pre>`;
  if (drawn === null) return publicNoPreviewPage(input);
  return publicReadingResponse(
    input.method,
    publicReadingPage({ title: input.title, body: `${heading(input.title)}${drawn}` }),
    "'none'",
    input.frameAncestor,
  );
}

export function publicNoPreviewPage(input: PublicFileRequest): Response {
  const locale = /^\s*zh\b/i.test(input.acceptLanguage ?? "") ? "zh-CN" : "en";
  return publicReadingResponse(
    input.method,
    publicReadingPage({
      title: input.title,
      body: `${heading(input.title)}<p class="empty">${escapeHtml(
        m.public_file_sign_in({}, { locale }),
      )}</p>`,
      lang: locale,
    }),
    "'none'",
    input.frameAncestor,
  );
}

const heading = (title: string) => `<h1>${escapeHtml(title)}</h1>`;

function csvTable(text: string): string | null {
  const [head, ...rows] = parseCsv(text);
  if (!head) return "<table></table>";
  const cells = rows.reduce((total, row) => total + row.cells.length, head.cells.length);
  if (cells > CSV_CELLS_DRAWN) return null;
  const row = (tag: "th" | "td", values: string[]) =>
    `<tr>${values.map((value) => `<${tag}>${escapeHtml(value)}</${tag}>`).join("")}</tr>`;
  return `<table><thead>${row("th", head.cells)}</thead><tbody>${rows
    .map((record) => row("td", record.cells))
    .join("")}</tbody></table>`;
}
