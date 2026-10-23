import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { FileTrigger } from "react-aria-components";
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Download01,
  Folder,
  RefreshCw01,
  Upload01,
  XClose,
} from "@untitledui/icons";
import {
  PI_CHAT_FILE_MAX_BYTES,
  PI_CHAT_UPLOAD_CHUNK_BYTES,
  type PiChatResult,
} from "@lrm/coforge-sdk/internal/pi-chat";
import { Button } from "#src/components/base/buttons/button";
import { Checkbox } from "#src/components/base/checkbox/checkbox";
import { FileTypeIcon } from "#src/features/files/file-type-icon";
import { formatFileSize } from "#src/features/files/file-meta";
import { m } from "#src/paraglide/messages";
import { executePiChat } from "./pi-chat.functions";

const FileView = lazy(() =>
  import("#src/features/projects/project-file-view").then((module) => ({
    default: module.ProjectFileView,
  })),
);
type Props = {
  computerId: string;
  computerName: string;
  workspaceSlug: string;
  supported: boolean;
  path?: string;
  onPath(path?: string): void;
  onMention(path: string): void;
  onClose(): void;
};

export function PiChatFiles(props: Props) {
  const { computerId, workspaceSlug, supported, path, onPath, onMention } = props;
  const execute = useServerFn(executePiChat);
  const queryClient = useQueryClient();
  const [hidden, setHidden] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState(false);
  const prefix = ["pi-chat-files", workspaceSlug, computerId];
  const directory = useQuery({
    queryKey: [...prefix, "directory", "", hidden],
    queryFn: () =>
      execute({ data: { computerId, command: { action: "files", path: "", hidden } } }),
    enabled: supported,
    refetchInterval: 3000,
    retry: false,
  });
  const preview = useQuery({
    queryKey: [...prefix, "file", path],
    queryFn: () => execute({ data: { computerId, command: { action: "file", path: path! } } }),
    enabled: supported && !!path,
    retry: false,
    staleTime: 0,
    refetchInterval: (query) =>
      (query.state.data?.file?.size ?? Infinity) <= 1024 * 1024 ? 5000 : false,
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: prefix });
  };
  const upload = async (file: File) => {
    setUploadError(false);
    if (file.size > PI_CHAT_FILE_MAX_BYTES) {
      setUploadError(true);
      return;
    }
    setUploading(true);
    const uploadId = crypto.randomUUID();
    try {
      for (
        let offset = 0;
        offset < file.size || offset === 0;
        offset += PI_CHAT_UPLOAD_CHUNK_BYTES
      ) {
        const bytes = new Uint8Array(
          await file.slice(offset, offset + PI_CHAT_UPLOAD_CHUNK_BYTES).arrayBuffer(),
        );
        let binary = "";
        for (const byte of bytes) binary += String.fromCharCode(byte);
        const result = await execute({
          data: {
            computerId,
            command: {
              action: "upload",
              uploadId,
              name: file.name,
              offset,
              total: file.size,
              data: btoa(binary),
            },
          },
        });
        if (result.uploaded) {
          onMention(result.uploaded);
          onPath(result.uploaded);
        }
        if (!file.size) break;
      }
      refresh();
    } catch {
      setUploadError(true);
    } finally {
      setUploading(false);
    }
  };
  return (
    <section
      aria-label={m.pi_chat_files()}
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-primary"
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-secondary p-3">
        <h2 className="text-sm font-semibold text-primary">{m.pi_chat_files()}</h2>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            color="tertiary"
            iconLeading={RefreshCw01}
            aria-label={m.pi_chat_retry()}
            onClick={refresh}
          />
          <Button
            size="sm"
            color="tertiary"
            iconLeading={XClose}
            aria-label={m.pi_chat_files_close()}
            onClick={props.onClose}
          />
        </div>
      </div>
      <div className="shrink-0 space-y-2 border-b border-secondary p-3 text-xs text-tertiary">
        <p className="truncate font-medium text-secondary">{props.computerName}</p>
        <p className="break-all font-mono">
          {directory.data?.directory?.root ?? m.pi_chat_files_scope()}
        </p>
        {supported && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Checkbox
              size="sm"
              isSelected={hidden}
              onChange={setHidden}
              label={m.pi_chat_files_hidden()}
            />
            <FileTrigger
              onSelect={(files) => {
                const file = files?.item(0);
                if (file) void upload(file);
              }}
            >
              <Button
                size="sm"
                color="secondary"
                iconLeading={Upload01}
                isDisabled={uploading}
                isLoading={uploading}
              >
                {m.pi_chat_files_upload()}
              </Button>
            </FileTrigger>
          </div>
        )}
        {uploadError && (
          <p role="alert" className="text-error-primary">
            {m.pi_chat_files_upload_error()}
          </p>
        )}
      </div>
      {!supported ? (
        <p className="p-3 text-sm text-tertiary">{m.pi_chat_files_upgrade()}</p>
      ) : path ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-secondary p-2">
            <Button size="sm" color="tertiary" iconLeading={ArrowLeft} onClick={() => onPath()}>
              {m.pi_chat_files()}
            </Button>
            <Button
              size="sm"
              color="secondary"
              onClick={() => onMention(preview.data?.file?.path ?? path)}
            >
              {m.pi_chat_files_mention()}
            </Button>
          </div>
          {preview.isPending && (
            <p role="status" className="p-3 text-sm text-tertiary">
              {m.pi_chat_loading()}
            </p>
          )}
          {preview.isError && (
            <p role="alert" className="p-3 text-sm text-error-primary">
              {m.pi_chat_files_error()}
            </p>
          )}
          {preview.data?.file && <FilePreview file={preview.data.file} />}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto p-2">
          {directory.isPending && (
            <p role="status" className="p-3 text-sm text-tertiary">
              {m.pi_chat_loading()}
            </p>
          )}
          {directory.isError && (
            <p role="alert" className="p-3 text-sm text-error-primary">
              {m.pi_chat_files_error()}
            </p>
          )}
          {directory.data?.directory?.entries.length === 0 && (
            <p className="p-3 text-sm text-tertiary">{m.pi_chat_files_empty()}</p>
          )}
          <FileEntries
            entries={directory.data?.directory?.entries ?? []}
            directory=""
            computerId={computerId}
            workspaceSlug={workspaceSlug}
            hidden={hidden}
            onPath={onPath}
          />
        </div>
      )}
    </section>
  );
}

function FileEntries({
  entries,
  directory,
  ...props
}: {
  entries: NonNullable<PiChatResult["directory"]>["entries"];
  directory: string;
  computerId: string;
  workspaceSlug: string;
  hidden: boolean;
  onPath(path: string): void;
}) {
  return (
    <ul className="space-y-1">
      {entries.map((entry) => (
        <FileEntry
          key={entry.name}
          entry={entry}
          path={[directory, entry.name].filter(Boolean).join("/")}
          {...props}
        />
      ))}
    </ul>
  );
}

function FileEntry({
  entry,
  path,
  ...props
}: {
  entry: NonNullable<PiChatResult["directory"]>["entries"][number];
  path: string;
  computerId: string;
  workspaceSlug: string;
  hidden: boolean;
  onPath(path: string): void;
}) {
  const [expanded, setExpanded] = useState(false);
  const execute = useServerFn(executePiChat);
  const children = useQuery({
    queryKey: [
      "pi-chat-files",
      props.workspaceSlug,
      props.computerId,
      "directory",
      path,
      props.hidden,
    ],
    queryFn: () =>
      execute({
        data: {
          computerId: props.computerId,
          command: { action: "files", path, hidden: props.hidden },
        },
      }),
    enabled: entry.directory && expanded,
    refetchInterval: expanded ? 3000 : false,
    retry: false,
  });
  return (
    <li>
      <Button
        size="sm"
        color="tertiary"
        className="w-full justify-start [&>span[data-text]]:min-w-0"
        aria-expanded={entry.directory ? expanded : undefined}
        onClick={() => (entry.directory ? setExpanded(!expanded) : props.onPath(path))}
      >
        {entry.directory ? (
          <>
            <span>
              {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
            </span>
            <Folder className="size-4 shrink-0" />
          </>
        ) : (
          <FileTypeIcon fileName={entry.name} className="size-5 shrink-0" />
        )}
        <span className="truncate">{entry.name}</span>
      </Button>
      {expanded && (
        <div className="border-l border-secondary pl-3">
          {children.isPending && (
            <p role="status" className="p-2 text-xs text-tertiary">
              {m.pi_chat_loading()}
            </p>
          )}
          {children.isError && (
            <p role="alert" className="p-2 text-xs text-error-primary">
              {m.pi_chat_files_error()}
            </p>
          )}
          <FileEntries
            entries={children.data?.directory?.entries ?? []}
            directory={path}
            {...props}
          />
        </div>
      )}
    </li>
  );
}

function FilePreview({ file }: { file: NonNullable<PiChatResult["file"]> }) {
  const content = useMemo(() => {
    const bytes = Uint8Array.from(atob(file.data), (char) => char.charCodeAt(0));
    const raster =
      bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71
        ? "image/png"
        : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
          ? "image/jpeg"
          : String.fromCharCode(...bytes.slice(0, 6)).startsWith("GIF8")
            ? "image/gif"
            : String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
                String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
              ? "image/webp"
              : undefined;
    return {
      url: URL.createObjectURL(new Blob([bytes], { type: raster ?? "application/octet-stream" })),
      image: !!raster,
      text: file.status === "ok" ? new TextDecoder().decode(bytes) : null,
    };
  }, [file]);
  useEffect(() => () => URL.revokeObjectURL(content.url), [content.url]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-secondary p-3">
        <p className="min-w-0 break-all text-xs text-secondary">
          {file.path} · {formatFileSize(file.size)}
        </p>
        {file.status !== "too_large" && (
          <Button
            size="sm"
            color="tertiary"
            iconLeading={Download01}
            href={content.url}
            download={file.path.split("/").at(-1)}
          >
            {m.pi_chat_files_download()}
          </Button>
        )}
      </div>
      {file.status === "too_large" ? (
        <p className="p-3 text-sm text-tertiary">{m.pi_chat_files_large()}</p>
      ) : content.image ? (
        <div className="min-h-0 flex-1 overflow-auto p-3">
          <img src={content.url} alt={file.path} className="max-w-full" />
        </div>
      ) : content.text !== null ? (
        <Suspense fallback={<p className="p-3 text-sm text-tertiary">{m.pi_chat_loading()}</p>}>
          <FileView
            key={file.path}
            path={file.path}
            name={file.path.split("/").at(-1)!}
            byteSize={file.size}
            text={content.text}
          />
        </Suspense>
      ) : (
        <p className="p-3 text-sm text-tertiary">{m.pi_chat_files_binary()}</p>
      )}
    </div>
  );
}
