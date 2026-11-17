import { memo, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Download01 } from "@untitledui/icons";
import { Button as AriaButton } from "react-aria-components";

import { Button } from "#src/components/base/buttons/button";
import { Skeleton } from "#src/components/ui/skeleton";
import { cn } from "#src/lib/utils";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { m } from "#src/paraglide/messages";
import { parseCsv } from "./artifact-csv";
import { artifactDownloadUrl } from "./artifact-download-url";
import { ArtifactCommentSurface } from "./artifact-comment-surface";
import { useArtifactCommenting } from "./artifact-commenting";
import { ArtifactMarkdown } from "./artifact-markdown";
import { artifactKindOfPath } from "./artifact-path-kind";
import { artifactFilePreviewQuery } from "./artifact-queries";
import { ArtifactPdfFrame, ArtifactWebPage } from "./artifact-web-page";
import { framedKind } from "./use-open-file";

const CSV_ROWS_SHOWN = 1000;

export function ArtifactFileView({
  artifactId,
  version,
  title,
  entryPath,
  path,
  source,
  finding,
  onFindingChange,
  onBack,
}: {
  artifactId: string;
  version: number;
  title: string;
  entryPath: string;
  path: string;
  source: boolean;
  finding: boolean;
  onFindingChange: (finding: boolean) => void;
  onBack: () => void;
}) {
  const workspaceSlug = useWorkspaceSlug();
  const download = artifactDownloadUrl(workspaceSlug, artifactId, { path, version });
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-secondary px-3 py-2">
        <Button size="sm" color="tertiary" iconLeading={ArrowLeft} onClick={onBack}>
          {m.av_file_back()}
        </Button>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-secondary">{path}</span>
        <Button size="sm" color="secondary" iconLeading={Download01} href={download}>
          {m.av_menu_download()}
        </Button>
      </div>
      {framedKind(path, entryPath, source) === "html" ? (
        <ArtifactWebPage
          key={`${version}:${path}`}
          artifactId={artifactId}
          version={version}
          title={title}
          entryPath={entryPath}
          path={path}
          finding={finding}
          onFindingChange={onFindingChange}
        />
      ) : (
        <ArtifactFile artifactId={artifactId} version={version} path={path} />
      )}
    </div>
  );
}

export function ArtifactFile({
  artifactId,
  version,
  path,
}: {
  artifactId: string;
  version: number;
  path: string;
}) {
  if (artifactKindOfPath(path) === "pdf")
    return (
      <ArtifactPdfFrame
        key={`${version}:${path}`}
        artifactId={artifactId}
        version={version}
        path={path}
      />
    );
  return <FilePreview artifactId={artifactId} version={version} path={path} />;
}

function FilePreview({
  artifactId,
  version,
  path,
}: {
  artifactId: string;
  version: number;
  path: string;
}) {
  const preview = useQuery(artifactFilePreviewQuery(artifactId, version, path));
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      {preview.isPending ? (
        <Skeleton className="m-4 h-40" />
      ) : preview.isError ? (
        <p className="p-6 text-sm text-error-primary">{m.av_file_failed()}</p>
      ) : (
        <FileBody path={path} preview={preview.data} />
      )}
    </div>
  );
}

function FileBody({
  path,
  preview,
}: {
  path: string;
  preview: { text: string | null; dataUrl: string | null };
}) {
  const kind = artifactKindOfPath(path);
  const { commenting } = useArtifactCommenting();
  if (preview.dataUrl)
    return (
      <div className="flex flex-1 items-start justify-center p-4">
        <img src={preview.dataUrl} alt={path} className="max-h-full max-w-full object-contain" />
      </div>
    );
  if (preview.text === null)
    return <p className="p-6 text-sm text-tertiary">{m.av_file_no_preview()}</p>;
  if (kind === "markdown") return <ArtifactMarkdown path={path} text={preview.text} />;
  return (
    <ArtifactCommentSurface path={path} kind="lines">
      {kind === "csv" ? (
        <CsvTable text={preview.text} selectable={commenting} />
      ) : (
        <CodeLines text={preview.text} selectable={commenting} />
      )}
    </ArtifactCommentSurface>
  );
}

function LineNumber({
  line,
  selectable,
  className,
}: {
  line: number;
  selectable: boolean;
  className: string;
}) {
  if (!selectable) return <span className={cn(className, "select-none")}>{line}</span>;
  return (
    <AriaButton
      aria-label={m.av_cm_select_line({ line })}
      data-anchor-select={line}
      className={cn(
        className,
        "cursor-pointer rounded-sm outline-focus-ring select-none hover:text-secondary focus-visible:outline-2",
      )}
    >
      {line}
    </AriaButton>
  );
}

const CodeLines = memo(function CodeLines({
  text,
  selectable,
}: {
  text: string;
  selectable: boolean;
}) {
  const lines = useMemo(() => text.replace(/\n$/, "").split("\n"), [text]);
  return (
    <div className="font-mono text-xs/5 text-primary">
      {lines.map((line, index) => (
        <div key={index} data-anchor-line={index + 1} className="flex">
          <LineNumber
            line={index + 1}
            selectable={selectable}
            className="w-12 shrink-0 pr-3 text-right text-quaternary"
          />
          <span className="min-w-0 flex-1 pr-4 break-all whitespace-pre-wrap">{line}</span>
        </div>
      ))}
    </div>
  );
});

const CsvTable = memo(function CsvTable({
  text,
  selectable,
}: {
  text: string;
  selectable: boolean;
}) {
  const records = useMemo(() => parseCsv(text), [text]);
  const [head, ...body] = records.slice(0, CSV_ROWS_SHOWN + 1);
  const capped = records.length > CSV_ROWS_SHOWN + 1;
  return (
    <table
      data-anchor-capped={capped ? "" : undefined}
      className="w-max min-w-full border-collapse text-sm"
    >
      <thead className="sticky top-0 bg-secondary">
        <tr data-anchor-line={head?.line} data-anchor-end={head?.endLine}>
          <th className="w-12 border-b border-secondary pr-3 text-right text-xs font-normal">
            {head && (
              <LineNumber line={head.line} selectable={selectable} className="text-quaternary" />
            )}
          </th>
          {(head?.cells ?? []).map((cell, index) => (
            <th
              key={index}
              className="border-b border-secondary px-3 py-1.5 text-left font-semibold text-secondary"
            >
              {cell}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {body.map((record) => (
          <tr
            key={record.line}
            data-anchor-line={record.line}
            data-anchor-end={record.endLine}
            className="border-b border-secondary"
          >
            <td className="pr-3 text-right text-xs">
              <LineNumber line={record.line} selectable={selectable} className="text-quaternary" />
            </td>
            {record.cells.map((cell, column) => (
              <td key={column} className="px-3 py-1.5 text-primary">
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
});
