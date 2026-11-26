import {
  FEEDBACK_ATTACHMENT_MAX_BYTES,
  FEEDBACK_ATTACHMENT_TYPES,
  type FeedbackCategory,
} from "./feedback-types";

export function detectClientInfo(): string {
  if (typeof navigator === "undefined") return "Web";
  const ua = navigator.userAgent;
  const os = /iPhone|iPad|iPod/i.test(ua)
    ? "iOS"
    : /Android/i.test(ua)
      ? "Android"
      : /Mac OS X/i.test(ua)
        ? "macOS"
        : /Windows/i.test(ua)
          ? "Windows"
          : /Linux/i.test(ua)
            ? "Linux"
            : null;
  return os ? `Web · ${os}` : "Web";
}

export function isAcceptedFeedbackImage(file: File): boolean {
  return (
    (FEEDBACK_ATTACHMENT_TYPES as readonly string[]).includes(file.type) &&
    file.size > 0 &&
    file.size <= FEEDBACK_ATTACHMENT_MAX_BYTES
  );
}

export async function submitFeedbackForm(input: {
  category: FeedbackCategory;
  body: string;
  workspaceId?: string;
  pagePath?: string;
  clientInfo?: string;
  files: readonly File[];
}): Promise<{ id: string; createdAt: string }> {
  const form = new FormData();
  form.set("category", input.category);
  form.set("body", input.body);
  if (input.workspaceId) form.set("workspaceId", input.workspaceId);
  if (input.pagePath) form.set("pagePath", input.pagePath);
  if (input.clientInfo) form.set("clientInfo", input.clientInfo);
  for (const file of input.files) {
    form.append("files", file);
  }
  const response = await fetch("/api/feedback", {
    method: "POST",
    body: form,
    credentials: "same-origin",
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { code?: string } | null;
    throw new Error(payload?.code ?? "SUBMIT_FAILED");
  }
  return (await response.json()) as { id: string; createdAt: string };
}
