import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Download01 } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { Skeleton } from "#src/components/ui/skeleton";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { m } from "#src/paraglide/messages";
import { parseCsv } from "./artifact-csv";
import { artifactDownloadUrl } from "./artifact-download-url";
import { ArtifactMarkdown } from "./artifact-markdown";
import { artifactKindOfPath } from "./artifact-path-kind";
import { artifactFilePreviewQuery } from "./artifact-queries";

const CSV_ROWS_SHOWN = 1000;

export function ArtifactFileView({
  artifactId,
  version,
  path,
  onBack,
}: {
  artifactId: string;
  version: number;
  path: string;
  onBack: () => void;
}) {
  const workspaceSlug = useWorkspaceSlug();
  const preview = useQuery(artifactFilePreviewQuery(artifactId, version, path));
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
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        {preview.isPending ? (
          <Skeleton className="m-4 h-40" />
        ) : preview.isError ? (
          <p className="p-6 text-sm text-error-primary">{m.av_file_failed()}</p>
        ) : (
          <FileBody path={path} preview={preview.data} />
        )}
      </div>
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
  if (preview.dataUrl)
    return (
      <div className="flex flex-1 items-start justify-center p-4">
        <img src={preview.dataUrl} alt={path} className="max-h-full max-w-full object-contain" />
      </div>
    );
  if (preview.text === null)
    return <p className="p-6 text-sm text-tertiary">{m.av_file_no_preview()}</p>;
  if (kind === "markdown") return <ArtifactMarkdown text={preview.text} />;
  if (kind === "csv") return <CsvTable text={preview.text} />;
  return <CodeLines text={preview.text} />;
}

function CodeLines({ text }: { text: string }) {
  const lines = useMemo(() => text.replace(/\n$/, "").split("\n"), [text]);
  return (
    <div className="font-mono text-xs/5 text-primary">
      {lines.map((line, index) => (
        <div key={index} className="flex">
          <span className="w-12 shrink-0 pr-3 text-right text-quaternary select-none">
            {index + 1}
          </span>
          <span className="min-w-0 flex-1 pr-4 break-all whitespace-pre-wrap">{line}</span>
        </div>
      ))}
    </div>
  );
}

function CsvTable({ text }: { text: string }) {
  const rows = useMemo(() => parseCsv(text).slice(0, CSV_ROWS_SHOWN + 1), [text]);
  const [head, ...body] = rows;
  return (
    <table className="w-max min-w-full border-collapse text-sm">
      <thead className="sticky top-0 bg-secondary">
        <tr>
          <th className="w-12 border-b border-secondary" />
          {(head ?? []).map((cell, index) => (
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
        {body.map((row, index) => (
          <tr key={index} className="border-b border-secondary">
            <td className="pr-3 text-right text-xs text-quaternary select-none">{index + 1}</td>
            {row.map((cell, column) => (
              <td key={column} className="px-3 py-1.5 text-primary">
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
