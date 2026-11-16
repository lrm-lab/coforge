import { AppError } from "#src/lib/app-error";

export const PAGE_DOCUMENT_MAX_BYTES = 64 * 1024;
export const PAGE_DATA_MAX_BYTES = 5 * 1024 * 1024;
export const PAGE_DATA_MAX_DOCUMENTS = 10_000;
export const PAGE_QUERY_MAX = 200;
export const PAGE_QUERY_DEFAULT = 50;
export const PAGE_QUERY_CONDITIONS_MAX = 8;
const JSON_DEPTH_MAX = 16;

const COLLECTION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DOC_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

const invalid = (errorId: string): never => {
  throw new AppError("INVALID_INPUT", { errorId });
};

export const pageCollection = (value: unknown): string =>
  typeof value === "string" && COLLECTION.test(value) ? value : invalid("artifact-data-collection");

export const pageDocId = (value: unknown): string =>
  typeof value === "string" && DOC_ID.test(value) ? value : invalid("artifact-data-id");

export const pageField = (value: unknown): string =>
  typeof value === "string" && FIELD.test(value) ? value : invalid("artifact-data-field");

function isPlainJson(value: unknown, depth: number): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (depth >= JSON_DEPTH_MAX) return false;
  if (Array.isArray(value)) return value.every((item) => isPlainJson(item, depth + 1));
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Object.values(value).every((item) => isPlainJson(item, depth + 1));
}

export type PageDocumentData = { data: Record<string, unknown>; sizeBytes: number };

export function pageDocumentData(value: unknown): PageDocumentData {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return invalid("artifact-data-shape");
  if (!isPlainJson(value, 0)) return invalid("artifact-data-shape");
  const sizeBytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  if (sizeBytes > PAGE_DOCUMENT_MAX_BYTES) return invalid("artifact-data-document-too-large");
  return { data: value as Record<string, unknown>, sizeBytes };
}

export const pageIfVersion = (value: unknown): number | undefined => {
  if (value === undefined) return undefined;
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : invalid("artifact-data-version");
};
