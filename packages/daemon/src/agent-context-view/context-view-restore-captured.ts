import type {
  RecordValue,
  RestoreRequest,
  ContextViewRestoreResult,
  RestoredContextMessage,
} from "./context-view-restore";
import { createHash } from "node:crypto";
import { restorePiIndexed } from "./context-view-restore-indexed-pi";
import { piRequestMessages, piResponseParts } from "./context-view-pi-projection";

function piRequestDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

import {
  hasHashMismatch,
  hasMessageId,
  hasNestedIdentityConflict,
  isRecord,
  message,
  providerPayload,
  sessionMatches,
  buildView,
} from "./context-view-restore";

export function restorePi(
  records: RecordValue[],
  request: RestoreRequest,
): ContextViewRestoreResult {
  const indexed = restorePiIndexed(records, request);
  if (indexed) return indexed;
  const messages: RestoredContextMessage[] = [];
  let previousHash: string | undefined;
  let sawTarget = false;
  let responseSeen = false;
  let requestSeen = false;
  let responseFound = false;
  let trigger: { toolUseId: string } | undefined;
  let model: string | null = null;
  let requestAt: string | null = null;
  const supportedApis = new Set([
    "anthropic-messages",
    "openai-completions",
    "openai-responses",
    "azure-openai-responses",
    "openai-codex-responses",
    "google-generative-ai",
    "google-vertex",
  ]);
  const targetIndex = records.findIndex((record) => hasMessageId(record, request.messageId));
  const boundary =
    targetIndex < 0
      ? records.length
      : records.findIndex((record, index) => index > targetIndex && record.type === "request");
  const bounded = records.slice(0, boundary >= 0 ? boundary : records.length);
  for (const [index, original] of bounded.entries()) {
    if (hasNestedIdentityConflict(original)) return { ok: false, failure: "context_mismatch" };
    const record = providerPayload(original);
    if (!sessionMatches(record, request.sessionId))
      return { ok: false, failure: "context_mismatch" };
    if (hasHashMismatch(record)) return { ok: false, failure: "context_mismatch" };
    const priorHash = previousHash;
    if (typeof record.prevHash === "string" && record.prevHash !== priorHash)
      return { ok: false, failure: "context_mismatch" };
    if (typeof record.hash === "string" && record.hash.length === 64) {
      const { hash: _hash, ...withoutHash } = record;
      if (piRequestDigest(withoutHash) !== record.hash)
        return { ok: false, failure: "context_mismatch" };
    }
    if (record.type === "request" && record.digest !== undefined && isRecord(record.body)) {
      if (typeof record.digest !== "string" || piRequestDigest(record.body) !== record.digest)
        return { ok: false, failure: "context_mismatch" };
    }
    if (typeof record.hash === "string") previousHash = record.hash;
    const api = record.api ?? (isRecord(record.body) ? record.body.api : undefined);
    if (api !== undefined && (typeof api !== "string" || !supportedApis.has(api)))
      return { ok: false, failure: "unsupported_runtime" };
    if (record.type === "request" && isRecord(record.body)) {
      messages.push(...piRequestMessages(record.body, typeof api === "string" ? api : undefined));
      responseSeen = false;
      requestSeen = true;
      if (typeof record.body.model === "string") model = record.body.model;
      if (typeof record.timestamp === "string") requestAt = record.timestamp;
    } else if (record.type === "response" && requestSeen && !responseSeen) {
      messages.push(message("assistant", piResponseParts(record.body)));
      responseSeen = true;
      if ((targetIndex >= 0 && index > targetIndex) || hasMessageId(record, request.messageId))
        responseFound = true;
      const text =
        typeof record.body === "string" ? record.body : JSON.stringify(record.body ?? "");
      if (
        typeof record.toolCallId === "string" &&
        new RegExp(
          `Message ID: ${request.messageId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_-])`,
        ).test(text)
      )
        trigger = { toolUseId: record.toolCallId };
    } else if (record.type === "gap") return { ok: false, failure: "not_recorded" };
    else if (record.type === "media" || record.type === "request_media")
      return { ok: false, failure: "media_removed" };
    if (record.type === "rollback" || record.type === "thread_rolled_back")
      return { ok: false, failure: "context_mismatch" };
    if (hasMessageId(record, request.messageId)) sawTarget = true;
    if (record.type === "unknown_future" || record.type === "unsupported_future")
      return { ok: false, failure: "newer_session_format" };
  }
  if (!messages.length) return { ok: false, failure: "not_found" };
  const built = buildView(
    request,
    messages,
    "pi-request-log",
    sawTarget ? "verified" : "count_matched",
  );
  if (built.ok) {
    built.view.responseFound = responseFound;
    built.view.model = model;
    built.view.requestAt = requestAt;
    if (trigger) built.view.trigger = trigger;
  }
  return built;
}
