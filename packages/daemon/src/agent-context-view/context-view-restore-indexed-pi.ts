import { createHash } from "node:crypto";
import {
  recordEnd,
  type RecordValue,
  type RestoreRequest,
  type ContextViewRestoreResult,
} from "./context-view-restore";
import { buildView, isRecord, message, sessionMatches } from "./context-view-restore-primitives";
import { piRequestMessages, piResponseParts } from "./context-view-pi-projection";

function piRequestDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function piContextRequestDigest(
  shapeHash: string,
  paramsJson: string,
  messageHashes: readonly string[],
): string {
  return createHash("sha256")
    .update(`${shapeHash}\n${paramsJson}\n${messageHashes.join("\n")}`)
    .digest("hex");
}

type IndexedPiRequest = RecordValue & {
  id: string;
  shapeHash: string;
  keep: number;
  tail: string[];
  digest: string;
  base: string | null;
  params: RecordValue;
  sourceIndex: number;
};

function reportsMessage(value: unknown, messageId: string): boolean {
  const escaped = messageId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `Message ID:\\s*${escaped}(?![A-Za-z0-9_-])|["']messageId["']\\s*:\\s*["']${escaped}["']`,
  ).test(typeof value === "string" ? value : JSON.stringify(value ?? ""));
}

function holdsSendResult(messages: readonly { parts: unknown[] }[], messageId: string): boolean {
  return messages.some((entry) =>
    entry.parts.some(
      (part) =>
        isRecord(part) && part.kind === "tool_result" && reportsMessage(part.output, messageId),
    ),
  );
}

function sameMessage(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function restorePiIndexed(
  records: RecordValue[],
  request: RestoreRequest,
): ContextViewRestoreResult | undefined {
  if (!records.some((record) => record.type === "shape" || record.type === "blob"))
    return undefined;
  const shapes = new Map<string, { messagesKey: string; shape: RecordValue }>();
  const blobs = new Map<string, unknown>();
  const requests = new Map<string, IndexedPiRequest>();
  const order: Array<IndexedPiRequest | { gap: string; sourceIndex: number }> = [];
  for (const [sourceIndex, record] of records.entries()) {
    if (record.type === "shape" && typeof record.hash === "string" && isRecord(record.shape)) {
      shapes.set(record.hash, {
        messagesKey: typeof record.messagesKey === "string" ? record.messagesKey : "messages",
        shape: record.shape,
      });
    } else if (record.type === "blob" && typeof record.hash === "string") {
      blobs.set(record.hash, record.message);
    } else if (
      record.type === "request" &&
      typeof record.id === "string" &&
      typeof record.shapeHash === "string" &&
      typeof record.digest === "string" &&
      typeof record.keep === "number" &&
      Number.isSafeInteger(record.keep) &&
      record.keep >= 0 &&
      Array.isArray(record.tail) &&
      record.tail.every((hash) => typeof hash === "string")
    ) {
      const indexed: IndexedPiRequest = {
        ...record,
        id: record.id,
        shapeHash: record.shapeHash,
        keep: record.keep,
        tail: record.tail as string[],
        digest: record.digest,
        base: typeof record.base === "string" ? record.base : null,
        params: isRecord(record.params) ? record.params : {},
        sourceIndex,
      };
      requests.set(indexed.id, indexed);
      order.push(indexed);
    } else if (record.type === "gap") {
      order.push({
        gap: typeof record.reason === "string" ? record.reason : "unknown",
        sourceIndex,
      });
    }
  }
  if (order.length === 0) return { ok: false, failure: "not_found" };
  const responseRequestSources = new Set<number>();
  let activeRequestSource = -1;
  for (const [sourceIndex, record] of records.entries()) {
    if (record.type === "request" && typeof record.shapeHash === "string") {
      activeRequestSource = sourceIndex;
      continue;
    }
    if (
      activeRequestSource >= 0 &&
      record.type === "response" &&
      sessionMatches(record, request.sessionId) &&
      reportsMessage(record.body ?? record, request.messageId)
    )
      responseRequestSources.add(activeRequestSource);
  }
  const hashesFor = (entry: IndexedPiRequest): string[] | null => {
    const chain: IndexedPiRequest[] = [];
    const seen = new Set<string>();
    let current: IndexedPiRequest | undefined = entry;
    while (current) {
      if (seen.has(current.id)) return null;
      seen.add(current.id);
      chain.push(current);
      current = current.base === null ? undefined : requests.get(current.base);
      if (chain.at(-1)?.base !== null && !current) return null;
    }
    const hashes: string[] = [];
    for (const step of chain.reverse()) {
      if (step.keep > hashes.length) return null;
      hashes.length = step.keep;
      hashes.push(...step.tail);
    }
    return hashes;
  };
  const verifiedMessages = (entry: IndexedPiRequest): unknown[] | null => {
    const shape = shapes.get(entry.shapeHash);
    const hashes = hashesFor(entry);
    if (!shape || !hashes || piRequestDigest(shape.shape) !== entry.shapeHash) return null;
    if (
      piContextRequestDigest(entry.shapeHash, JSON.stringify(entry.params), hashes) !== entry.digest
    )
      return null;
    const messages: unknown[] = [];
    for (const hash of hashes) {
      if (!blobs.has(hash) || piRequestDigest(blobs.get(hash)) !== hash) return null;
      messages.push(blobs.get(hash));
    }
    return messages;
  };
  let matchingIndex = -1;
  for (const [index, entry] of order.entries()) {
    if (
      "id" in entry &&
      sessionMatches(entry, request.sessionId) &&
      (recordEnd(entry) === undefined || recordEnd(entry)! <= request.offset) &&
      ((Array.isArray(entry.messageIds) && entry.messageIds.includes(request.messageId)) ||
        reportsMessage(entry, request.messageId) ||
        responseRequestSources.has(entry.sourceIndex))
    )
      matchingIndex = index;
  }
  let candidate: IndexedPiRequest | undefined;
  let messages: unknown[] | null = null;
  let projected: ReturnType<typeof piRequestMessages> | undefined;
  for (let index = matchingIndex; index >= 0; index -= 1) {
    const current = order[index];
    if (!current || !("id" in current) || !sessionMatches(current, request.sessionId)) continue;
    const currentShape = shapes.get(current.shapeHash);
    const currentMessages = verifiedMessages(current);
    if (!currentShape || !currentMessages) return { ok: false, failure: "context_mismatch" };
    const currentBody = {
      ...currentShape.shape,
      ...current.params,
      [currentShape.messagesKey]: currentMessages,
    };
    if (isRecord(currentShape.shape.config) || isRecord(current.params.config))
      currentBody.config = {
        ...(isRecord(currentShape.shape.config) ? currentShape.shape.config : {}),
        ...(isRecord(current.params.config) ? current.params.config : {}),
      };
    const currentApi = typeof current.api === "string" ? current.api : undefined;
    const currentProjected = piRequestMessages(currentBody, currentApi);
    if (holdsSendResult(currentProjected, request.messageId)) continue;
    candidate = current;
    messages = currentMessages;
    projected = currentProjected;
    break;
  }
  if (!candidate || !messages || !projected) return { ok: false, failure: "not_found" };
  const shape = shapes.get(candidate.shapeHash);
  if (!shape) return { ok: false, failure: "context_mismatch" };
  const api = typeof candidate.api === "string" ? candidate.api : undefined;
  const supportedApis = new Set([
    "anthropic-messages",
    "openai-completions",
    "openai-responses",
    "azure-openai-responses",
    "openai-codex-responses",
    "google-generative-ai",
    "google-vertex",
  ]);
  if (!api || !supportedApis.has(api)) return { ok: false, failure: "unsupported_runtime" };
  let responseFound = false;
  let trigger: { toolUseId: string } | undefined;
  const nextRequest = order.find(
    (entry): entry is IndexedPiRequest =>
      "id" in entry &&
      sessionMatches(entry, request.sessionId) &&
      entry.sourceIndex > candidate!.sourceIndex,
  );
  if (nextRequest) {
    const nextShape = shapes.get(nextRequest.shapeHash);
    const nextMessages = verifiedMessages(nextRequest);
    if (!nextShape || !nextMessages) return { ok: false, failure: "context_mismatch" };
    const nextBody = {
      ...nextShape.shape,
      ...nextRequest.params,
      [nextShape.messagesKey]: nextMessages,
    };
    const nextProjected = piRequestMessages(
      nextBody,
      typeof nextRequest.api === "string" ? nextRequest.api : undefined,
    );
    if (
      nextProjected.length > projected.length &&
      projected.every((entry, index) => sameMessage(entry, nextProjected[index]))
    ) {
      const continuation = nextProjected.slice(projected.length);
      const replyEnd = continuation.findIndex((entry) => entry.role !== "assistant");
      const reply = replyEnd < 0 ? continuation : continuation.slice(0, replyEnd);
      projected.push(...reply);
      responseFound = reply.length > 0;
      const result = continuation
        .slice(reply.length)
        .flatMap((entry) => entry.parts)
        .find(
          (part) =>
            isRecord(part) &&
            part.kind === "tool_result" &&
            reportsMessage(part.output, request.messageId),
        );
      if (isRecord(result) && typeof result.toolUseId === "string")
        trigger = { toolUseId: result.toolUseId };
    }
  }
  for (const record of records.slice(candidate.sourceIndex + 1)) {
    if (record.type === "gap") {
      if (record.reason === "off" || record.reason === "write_failed")
        return { ok: false, failure: "not_recorded" };
      break;
    }
    if (record.type === "request" && typeof record.shapeHash === "string") break;
    if (record.type !== "response" || !sessionMatches(record, request.sessionId)) continue;
    if (
      !(
        (Array.isArray(record.messageIds) && record.messageIds.includes(request.messageId)) ||
        reportsMessage(record.body ?? record, request.messageId)
      )
    )
      continue;
    projected.push(message("assistant", piResponseParts(record.body)));
    responseFound = true;
    const output =
      typeof record.body === "string" ? record.body : JSON.stringify(record.body ?? "");
    if (
      typeof record.toolCallId === "string" &&
      new RegExp(
        `Message ID: ${request.messageId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_-])`,
      ).test(output)
    )
      trigger = { toolUseId: record.toolCallId };
    break;
  }
  const built = buildView(request, projected, "raft-request-log", "verified");
  if (!built.ok) return built;
  built.view.responseFound = responseFound;
  built.view.model = typeof candidate.model === "string" ? candidate.model : null;
  built.view.requestAt = typeof candidate.at === "string" ? candidate.at : null;
  if (trigger) built.view.trigger = trigger;
  return built;
}
export { restorePiIndexed };
