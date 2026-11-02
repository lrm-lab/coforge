// OSS object operations every release feed shares: probe, read, upload (multipart above a size)
// and the redacted error they all report. publish.ts composes them into a publication.
import OSS from "ali-oss";

import type { OssConnection } from "./oss-client";

/** The request URL for an object, built the same way the SDK itself would route the request
 * (bucket-prefixed host unless `cname` is set) - used only for the unauthenticated
 * `verifyPrivateOrigin` probe in publish.ts, which deliberately does not go through the signed
 * client. */
export function objectOrigin(connection: OssConnection, objectKey: string): string {
  const secure = connection.secure ?? true;
  const withScheme = /^https?:\/\//i.test(connection.endpoint)
    ? connection.endpoint
    : `${secure ? "https" : "http"}://${connection.endpoint}`;
  const url = new URL(withScheme);
  if (!connection.cname) {
    url.hostname = `${connection.bucket}.${url.hostname}`;
  }
  url.pathname = `/${objectKey}`;
  url.search = "";
  return url.toString();
}

/** Resolves true when the error is ali-oss's "object not found" shape (a HEAD/GET 404, reported
 * as `code: "NoSuchKey"`), false otherwise. Mirrors `apps/web`'s `isMissingObject`. */
export function isMissingObject(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code, status } = error as { code?: unknown; status?: unknown };
  return code === "NoSuchKey" || status === 404;
}

/** The only diagnostic a failed OSS call is allowed to surface: an HTTP status, OSS's own code, the
 * error's *class name*, the object key, and OSS's request id. It deliberately excludes the SDK
 * error's `message` and any response body/header - a real OSS `SignatureDoesNotMatch` error echoes
 * the `StringToSign`, the supplied `Signature`, and the `AccessKeyId` back to the caller, so
 * surfacing that text would leak exactly the material this function exists to protect. See
 * publish.test.ts's credential-leak test, which fails if this function is changed to include either.
 *
 * The class name is in because it is a *kind*, not content: a transport failure reports no status
 * (`HTTP unknown`), and `ResponseTimeoutError` versus `ConnectionTimeoutError` is the diagnosis. */
export function ossError(action: string, objectKey: string, error: unknown): Error {
  const { status, code, requestId, name } =
    typeof error === "object" && error !== null
      ? (error as { status?: unknown; code?: unknown; requestId?: unknown; name?: unknown })
      : {};
  const statusText = typeof status === "number" ? status : "unknown";
  const codeText = typeof code === "string" && code.length > 0 ? ` code=${code}` : "";
  // `Error` itself says nothing; a class name that differs from it is the interesting case.
  const nameText =
    typeof name === "string" && name.length > 0 && name !== "Error" ? ` ${name}` : "";

  const requestIdText =
    typeof requestId === "string" && requestId.length > 0 ? requestId : "unknown";
  return new Error(
    `OSS ${action} failed: HTTP ${statusText}${codeText}${nameText} ${objectKey} request-id=${requestIdText}`,
  );
}

/* -------------------------------------------------------------------------------------------- */
/* Upload primitives                                                                             */
/* -------------------------------------------------------------------------------------------- */

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let index = 0; index < a.byteLength; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

/** Objects at or above this size are uploaded as several parts so a slow link cannot blow one
 * request's timeout on the whole object. The darwin-arm64 binary (~28 MiB, uploaded first) once
 * exceeded ali-oss's default 60 s per-request timeout below ~0.5 MB/s and died with a
 * `ResponseTimeoutError` (name only, no status/code/request-id). Parts use ali-oss's defaults
 * (1 MiB, 5 in parallel), so each 60 s request carries one megabyte, not a whole binary. */
const MULTIPART_MIN_BYTES = 20 * 1024 * 1024;
/** Whole-multipart attempts before giving up. ali-oss's own retry only covers status -1/-2, which
 * a `ResponseTimeoutError` lacks, so a timed-out part fails the whole call whatever `retryMax`
 * says; the outer retry below is what rescues it. Without a checkpoint, each attempt starts a new
 * multipart upload (a new uploadId) and re-sends the whole object. */
const MULTIPART_ATTEMPTS = 3;

/** Every other release object (the computer binary, its gzip, checksum sidecars, the manifest) is
 * served as opaque bytes; only photon_rs_bg.wasm has a real registered media type
 * (https://www.iana.org/assignments/media-types/application/wasm), so it is the one object key
 * this needs to special-case rather than a lookup table nothing else would ever hit. */
function contentTypeFor(objectKey: string): string {
  return objectKey.endsWith(".wasm") ? "application/wasm" : "application/octet-stream";
}

export async function putObject(
  client: OSS,
  objectKey: string,
  bytes: Uint8Array,
  requestTimeoutMs?: number,
): Promise<void> {
  const buffer = Buffer.from(bytes);
  const contentType = contentTypeFor(objectKey);
  // `requestTimeoutMs` is a test-only hook so the stalled-server fixture can pin the
  // `ResponseTimeoutError` reporting path; production uses ali-oss's 60 s default.
  const requestOptions = requestTimeoutMs ? { timeout: requestTimeoutMs } : {};
  try {
    if (buffer.byteLength >= MULTIPART_MIN_BYTES) {
      for (let attempt = 1; ; attempt += 1) {
        try {
          await client.multipartUpload(objectKey, buffer, {
            ...requestOptions,
            headers: { "Content-Type": contentType },
          });
          return;
        } catch (error) {
          // Only a timeout is worth re-attempting from here; anything else is either a
          // configuration fault (a 403) or a real server error, and ossError already names it.
          const name =
            typeof error === "object" && error !== null
              ? (error as { name?: unknown }).name
              : undefined;
          if (
            attempt >= MULTIPART_ATTEMPTS ||
            typeof name !== "string" ||
            !name.endsWith("TimeoutError")
          )
            throw error;
        }
      }
    }
    await client.put(objectKey, buffer, {
      ...requestOptions,
      headers: { "Content-Type": contentType },
    });
  } catch (error) {
    throw ossError("upload", objectKey, error);
  }
}

export async function getObject(client: OSS, objectKey: string): Promise<Uint8Array> {
  try {
    const result = await client.get(objectKey);
    return new Uint8Array(result.content as Buffer);
  } catch (error) {
    throw ossError("read-back", objectKey, error);
  }
}

/** Resolves true when the object exists, false on a 404, and throws on anything else: an
 * ambiguous status (403, 5xx) must not be read as "absent", or a transient error would overwrite
 * a published version. */
export async function objectExists(client: OSS, objectKey: string): Promise<boolean> {
  try {
    await client.head(objectKey);
    return true;
  } catch (error) {
    if (isMissingObject(error)) return false;
    throw ossError("probe", objectKey, error);
  }
}

/** The bytes of an object, or undefined when absent (a 404). Any other failure throws: an
 * ambiguous status (403, 5xx) must not be read as "absent". */
export async function readObjectIfPresent(
  client: OSS,
  objectKey: string,
): Promise<Uint8Array | undefined> {
  try {
    const result = await client.get(objectKey);
    return new Uint8Array(result.content as Buffer);
  } catch (error) {
    if (isMissingObject(error)) return undefined;
    throw ossError("read", objectKey, error);
  }
}
