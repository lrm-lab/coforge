import { useRef, useState } from "react";
import { Upload01 } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { formatFileSize } from "#src/features/files/file-meta";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { m } from "#src/paraglide/messages";
import { COMPUTER_FILE_MAX_BYTES } from "@lrm/coforge-sdk/internal";
import type { ComputerFileUploadRefusal } from "#src/routes/api/computers/$computerId/file-uploads";

type UploadStatus = "idle" | "uploading" | "ready" | "error";

function statusMessage(reason: string, detail?: string) {
  switch (reason as ComputerFileUploadRefusal | "signed_out") {
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
    case "signed_out":
      return m.computer_file_upload_signed_out();
    default:
      return detail || m.computer_file_upload_failed();
  }
}

function uploadComputerFile(
  computerId: string,
  workspaceSlug: string,
  file: File,
  onProgress: (percent: number) => void,
) {
  return new Promise<{ path: string; fileName: string; sizeBytes: number }>((resolve, reject) => {
    const form = new FormData();
    form.set("file", file);
    form.set("workspaceSlug", workspaceSlug);
    const request = new XMLHttpRequest();
    request.open("POST", `/api/computers/${computerId}/file-uploads`);
    request.responseType = "json";
    request.upload.onprogress = (event) => {
      if (!event.lengthComputable || event.total <= 0) return;
      onProgress(Math.min(99, Math.round((event.loaded / event.total) * 100)));
    };
    request.onload = () => {
      const body = request.response as {
        status?: string;
        path?: string;
        fileName?: string;
        sizeBytes?: number;
        reason?: string;
        message?: string;
      } | null;
      if (request.status >= 200 && request.status < 300 && body?.status === "ready" && body.path) {
        onProgress(100);
        resolve({
          path: body.path,
          fileName: body.fileName ?? file.name,
          sizeBytes: body.sizeBytes ?? file.size,
        });
        return;
      }
      const reason = body?.reason ?? (request.status === 401 ? "signed_out" : "failed");
      reject(Object.assign(new Error(body?.message || reason), { reason }));
    };
    request.onerror = () => reject(Object.assign(new Error("network"), { reason: "failed" }));
    request.onabort = () => reject(Object.assign(new Error("aborted"), { reason: "failed" }));
    request.send(form);
  });
}

/**
 * Owner control: POST the file to the web server (attachments-style), which stores it and asks
 * the Computer to pull into uploads/.
 */
export function ComputerFileUploadPanel({ computerId }: { computerId: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const workspaceSlug = useWorkspaceSlug();
  const [status, setStatus] = useState<UploadStatus>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [placedPath, setPlacedPath] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const busy = status === "uploading";

  const onPick = async (fileList: FileList | null) => {
    const file = fileList?.[0];
    if (!file || busy) return;
    setPlacedPath(null);
    setMessage(null);
    setProgress(0);
    if (file.size <= 0 || file.size > COMPUTER_FILE_MAX_BYTES) {
      setStatus("error");
      setMessage(statusMessage("too_large"));
      return;
    }
    setStatus("uploading");
    try {
      const placed = await uploadComputerFile(computerId, workspaceSlug, file, setProgress);
      setStatus("ready");
      setPlacedPath(placed.path);
      setMessage(m.computer_file_upload_ready({ path: placed.path }));
    } catch (error) {
      setStatus("error");
      const reason =
        error && typeof error === "object" && "reason" in error
          ? String((error as { reason: unknown }).reason)
          : "failed";
      const detail = error instanceof Error && error.message !== reason ? error.message : undefined;
      setMessage(statusMessage(reason, detail));
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
          {busy
            ? m.computer_file_upload_uploading_progress({ percent: String(progress) })
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
