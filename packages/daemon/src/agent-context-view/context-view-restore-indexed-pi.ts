import { createHash } from "node:crypto";
import type {
  RecordValue,
  RestoreRequest,
  ContextViewRestoreResult,
  RestoredContextMessage,
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
  const candidate = [...order]
    .reverse()
    .find(
      (entry): entry is IndexedPiRequest =>
        "id" in entry &&
        sessionMatches(entry, request.sessionId) &&
        ((Array.isArray(entry.messageIds) && entry.messageIds.includes(request.messageId)) ||
          JSON.stringify(entry).includes(request.messageId)),
    );
  if (!candidate) return { ok: false, failure: "not_found" };
  const shape = shapes.get(candidate.shapeHash);
  const messages = verifiedMessages(candidate);
  if (!shape || !messages) return { ok: false, failure: "context_mismatch" };
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
  const body = { ...shape.shape, ...candidate.params, [shape.messagesKey]: messages };
  const projected = piRequestMessages(body, api);
  let responseFound = false;
  let trigger: { toolUseId: string } | undefined;
  for (const record of records.slice(candidate.sourceIndex + 1)) {
    if (record.type === "gap") return { ok: false, failure: "not_recorded" };
    if (record.type !== "response" || !sessionMatches(record, request.sessionId)) continue;
    if (
      !(
        (Array.isArray(record.messageIds) && record.messageIds.includes(request.messageId)) ||
        JSON.stringify(record).includes(request.messageId)
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
