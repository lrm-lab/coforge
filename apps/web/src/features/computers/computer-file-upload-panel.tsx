import { useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Upload01 } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { formatFileSize } from "#src/features/files/file-meta";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { m } from "#src/paraglide/messages";
import { COMPUTER_FILE_MAX_BYTES } from "@lrm/coforge-sdk/internal";
import { awaitComputerFileUpload } from "./computer-file-upload-poll";
import { readComputerFileUpload } from "./computer-file-upload.functions";
import type { ComputerFileUploadRefusal } from "#src/routes/api/computers/$computerId/file-uploads";

type UploadStatus = "idle" | "uploading" | "ready" | "error";

function statusMessage(reason: string, detail?: string) {
  switch (reason as ComputerFileUploadRefusal) {
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

/** Sends the file; the server answers with the upload id once it has the whole body. */
function sendComputerFile(
  computerId: string,
  workspaceSlug: string,
  file: File,
  onProgress: (percent: number) => void,
) {
  return new Promise<{ uploadId: string }>((resolve, reject) => {
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
        uploadId?: string;
        reason?: string;
      } | null;
      if (
        request.status >= 200 &&
        request.status < 300 &&
        body?.status === "started" &&
        body.uploadId
      ) {
        resolve({ uploadId: body.uploadId });
        return;
      }
      const reason = body?.reason ?? (request.status === 401 ? "signed_out" : "failed");
      reject(Object.assign(new Error(reason), { reason }));
    };
    request.onerror = () => reject(Object.assign(new Error("network"), { reason: "failed" }));
    request.onabort = () => reject(Object.assign(new Error("aborted"), { reason: "failed" }));
    request.send(form);
  });
}

/**
 * Owner control: POST the file to the web server (attachments-style), which answers once it has
 * the body; the server then stores it and asks the Computer to pull into uploads/, and the panel
 * polls for the outcome while it shows the uploading state.
 */
export function ComputerFileUploadPanel({ computerId }: { computerId: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const workspaceSlug = useWorkspaceSlug();
  const readUpload = useServerFn(readComputerFileUpload);
  // Made when mounted rather than once, so a remount (Strict Mode's included) does not inherit a
  // stopped controller.
  const mounted = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    const controller = new AbortController();
    mounted.current = controller;
    return () => controller.abort();
  }, []);
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
    const signal = mounted.current!.signal;
    try {
      const { uploadId } = await sendComputerFile(computerId, workspaceSlug, file, setProgress);
      const placed = await awaitComputerFileUpload({
        read: () => readUpload({ data: { computerId, uploadId } }),
        signal,
      });
      if (signal.aborted) return;
      if (placed.status === "failed")
        throw Object.assign(new Error(placed.message || placed.reason), { reason: placed.reason });
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
