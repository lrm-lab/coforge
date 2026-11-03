import { useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Upload01 } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { formatFileSize } from "#src/features/files/file-meta";
import { m } from "#src/paraglide/messages";
import { COMPUTER_FILE_MAX_BYTES } from "@lrm/coforge-sdk/internal";
import {
  completeComputerFileUpload,
  createComputerFileUpload,
} from "./computer-file-upload.functions";

type UploadStatus =
  | "idle"
  | "uploading"
  | "placing"
  | "ready"
  | "error";

function statusMessage(
  status: Exclude<UploadStatus, "idle" | "uploading" | "placing" | "ready"> | string,
  detail?: string,
) {
  switch (status) {
    case "offline":
      return m.computer_file_upload_offline();
    case "unsupported":
      return m.computer_file_upload_unsupported();
    case "timeout":
      return m.computer_file_upload_timeout();
    case "storage_unavailable":
      return m.computer_file_upload_storage_unavailable();
    case "too_large":
      return m.computer_file_upload_too_large({ limit: formatFileSize(COMPUTER_FILE_MAX_BYTES) });
    case "invalid_name":
      return m.computer_file_upload_invalid_name();
    case "unavailable":
      return m.computer_file_upload_unavailable();
    default:
      return detail || m.computer_file_upload_failed();
  }
}

async function putToStorage(
  upload: { url: string; headers: Record<string, string> },
  file: File,
) {
  const response = await fetch(upload.url, {
    method: "PUT",
    headers: upload.headers,
    body: file,
  });
  if (!response.ok) throw new Error(`storage PUT ${response.status}`);
}

/**
 * Minimal owner control: pick a local file, PUT it to storage, then have the Computer pull it
 * into `/workspace/uploads` (or the Computer's workspaceRoot/uploads).
 */
export function ComputerFileUploadPanel({ computerId }: { computerId: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const createUpload = useServerFn(createComputerFileUpload);
  const completeUpload = useServerFn(completeComputerFileUpload);
  const [status, setStatus] = useState<UploadStatus>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [placedPath, setPlacedPath] = useState<string | null>(null);
  const busy = status === "uploading" || status === "placing";

  const onPick = async (fileList: FileList | null) => {
    const file = fileList?.[0];
    if (!file || busy) return;
    setPlacedPath(null);
    setMessage(null);
    if (file.size <= 0 || file.size > COMPUTER_FILE_MAX_BYTES) {
      setStatus("error");
      setMessage(
        statusMessage("too_large"),
      );
      return;
    }
    setStatus("uploading");
    try {
      const created = await createUpload({
        data: {
          computerId,
          fileName: file.name,
          contentType: file.type || "application/octet-stream",
          sizeBytes: file.size,
        },
      });
      if ("status" in created) {
        setStatus("error");
        setMessage(statusMessage(created.status));
        return;
      }
      await putToStorage(created.upload, file);
      setStatus("placing");
      const completed = await completeUpload({
        data: { computerId, uploadId: created.uploadId },
      });
      if (completed.status === "ready") {
        setStatus("ready");
        setPlacedPath(completed.path);
        setMessage(m.computer_file_upload_ready({ path: completed.path }));
        return;
      }
      setStatus("error");
      setMessage(
        completed.status === "failed"
          ? statusMessage("failed", completed.message)
          : statusMessage(completed.status),
      );
    } catch {
      setStatus("error");
      setMessage(m.computer_file_upload_failed());
    } finally {
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <div className="py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-primary">{m.computer_file_upload_title()}</p>
          <p className="text-sm text-tertiary">{m.computer_file_upload_description()}</p>
        </div>
        <Button
          type="button"
          size="sm"
          color="secondary"
          iconLeading={Upload01}
          isLoading={busy}
          showTextWhileLoading
          isDisabled={busy}
          onPress={() => inputRef.current?.click()}
        >
          {status === "uploading"
            ? m.computer_file_upload_uploading()
            : status === "placing"
              ? m.computer_file_upload_placing()
              : m.computer_file_upload_choose()}
        </Button>
        <input
          ref={inputRef}
          type="file"
          className="hidden"
          onChange={(event) => void onPick(event.target.files)}
        />
      </div>
      {message && (
        <p
          role={status === "error" ? "alert" : "status"}
          className={`mt-2 text-sm ${status === "error" ? "text-error-primary" : "text-tertiary"}`}
        >
          {message}
        </p>
      )}
      {placedPath && status === "ready" && (
        <p className="mt-1 font-mono text-xs text-tertiary">{placedPath}</p>
      )}
    </div>
  );
}
