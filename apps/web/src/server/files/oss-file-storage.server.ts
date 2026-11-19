import { Readable } from "node:stream";

import Credential from "@alicloud/credentials";
import OSS from "ali-oss";

import { AppError } from "#src/lib/app-error";

import {
  assertRemovablePrefix,
  type BulkFileRemoval,
  type ManagedFileStorage,
  type ObjectCopy,
  type FileStorage,
  type FileStorageConfig,
  type StoredFile,
} from "./file-storage.server";

const OSS_BATCH_MAX = 1000;

const ACCOUNT_LEVEL_ERROR_CODES = new Set([
  "UserDisable",
  "AccessDenied",
  "AccountProblem",
  "InvalidAccessKeyId",
  "InvalidSecurityToken",
  "SecurityTokenExpired",
]);

async function unlessAccountUnavailable<T>(operation: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const code = typeof error === "object" && error !== null ? Reflect.get(error, "code") : null;
    if (typeof code !== "string" || !ACCOUNT_LEVEL_ERROR_CODES.has(code)) throw error;
    console.warn(
      JSON.stringify({ event: "object_storage:unavailable", error_name: code, operation }),
    );
    throw new AppError("TEMPORARILY_UNAVAILABLE");
  }
}

type OssConfig = Extract<FileStorageConfig, { kind: "oss" }>;

export async function createOssFileStorage(config: OssConfig): Promise<ManagedFileStorage> {
  const region = `oss-${config.region}`;
  const customDomain = config.endpoint ? { endpoint: config.endpoint, cname: true } : null;
  const serverEndpoint = customDomain ?? { internal: config.internal };
  const presignEndpoint = customDomain ?? {};
  if (config.accessKey) {
    return new OssFileStorage(
      new OSS({
        ...config.accessKey,
        bucket: config.bucket,
        region,
        authorizationV4: true,
        ...serverEndpoint,
      }),
      new OSS({
        ...config.accessKey,
        bucket: config.bucket,
        region,
        authorizationV4: true,
        ...presignEndpoint,
      }),
    );
  }
  const chain = new Credential();
  const readCredential = async () => {
    const credential = await chain.getCredential();
    if (!credential.accessKeyId || !credential.accessKeySecret) {
      throw new Error("Alibaba Cloud credential chain returned no AccessKey");
    }
    return {
      accessKeyId: credential.accessKeyId,
      accessKeySecret: credential.accessKeySecret,
      stsToken: credential.securityToken ?? "",
    };
  };
  const initial = await readCredential();
  const shared = {
    bucket: config.bucket,
    region,
    authorizationV4: true,
    ...(initial.stsToken ? { refreshSTSToken: readCredential } : {}),
  };
  return new OssFileStorage(
    new OSS({ ...initial, ...shared, ...serverEndpoint }),
    new OSS({ ...initial, ...shared, ...presignEndpoint }),
  );
}

export class OssFileStorage implements FileStorage, BulkFileRemoval, ObjectCopy {
  constructor(
    private readonly client: OSS,
    private readonly presignClient: OSS,
  ) {}

  async put(objectKey: string, file: Blob, contentType: string) {
    const body = Buffer.from(await file.arrayBuffer());
    await unlessAccountUnavailable("put", () =>
      this.client.put(objectKey, body, {
        headers: { "Content-Type": contentType, "x-oss-forbid-overwrite": "true" },
      }),
    );
  }

  async open(objectKey: string): Promise<StoredFile | null> {
    let result: Awaited<ReturnType<OSS["getStream"]>>;
    try {
      result = await unlessAccountUnavailable("open", () => this.client.getStream(objectKey));
    } catch (error) {
      if (isMissingObject(error)) return null;
      throw error;
    }
    const headers = result.res.headers as Record<string, string | undefined>;
    const length = Number(headers["content-length"]);
    return {
      body: Readable.toWeb(result.stream as Readable) as unknown as ReadableStream<Uint8Array>,
      contentType: headers["content-type"] ?? null,
      sizeBytes: Number.isFinite(length) ? length : null,
    };
  }

  async copyObject(fromKey: string, toKey: string) {
    await unlessAccountUnavailable("copy", () =>
      this.client.copy(toKey, fromKey, { headers: { "x-oss-forbid-overwrite": "true" } }),
    );
  }

  async remove(objectKey: string) {
    await unlessAccountUnavailable("remove", () => this.client.delete(objectKey));
  }

  async removeMany(objectKeys: readonly string[]) {
    for (let start = 0; start < objectKeys.length; start += OSS_BATCH_MAX)
      await unlessAccountUnavailable("remove_many", () =>
        this.client.deleteMulti(objectKeys.slice(start, start + OSS_BATCH_MAX), { quiet: true }),
      );
  }

  async removePrefix(prefix: string) {
    assertRemovablePrefix(prefix);
    let continuationToken: string | undefined;
    do {
      const page = await unlessAccountUnavailable("remove_prefix", () =>
        this.client.listV2({
          prefix,
          "max-keys": OSS_BATCH_MAX,
          ...(continuationToken ? { "continuation-token": continuationToken } : {}),
        }),
      );
      const keys = (page.objects ?? []).map((object) => object.name);
      if (keys.length)
        await unlessAccountUnavailable("remove_prefix", () =>
          this.client.deleteMulti(keys, { quiet: true }),
        );
      continuationToken = page.isTruncated ? page.nextContinuationToken : undefined;
    } while (continuationToken);
  }

  async head(objectKey: string) {
    let result: Awaited<ReturnType<OSS["head"]>>;
    try {
      result = await unlessAccountUnavailable("head", () => this.client.head(objectKey));
    } catch (error) {
      if (isMissingObject(error)) return null;
      throw error;
    }
    const headers = result.res.headers as Record<string, string | undefined>;
    const length = Number(headers["content-length"]);
    return {
      sizeBytes: Number.isFinite(length) ? length : 0,
      contentType: headers["content-type"] ?? null,
    };
  }

  async readPrefix(objectKey: string, input: { maxBytes: number; signal: AbortSignal }) {
    input.signal.throwIfAborted();
    if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes <= 0)
      throw new Error("invalid prefix length");
    const headers = {
      Range: `bytes=0-${input.maxBytes - 1}`,
      "x-oss-range-behavior": "standard",
      "Accept-Encoding": "identity",
    };
    const url = await this.client.signatureUrlV4("GET", 60, { headers }, objectKey, ["range"]);
    input.signal.throwIfAborted();
    const response = await fetch(url, {
      headers,
      signal: input.signal,
      redirect: "error",
      decompress: false,
    });
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    const range = /^bytes 0-(\d+)\/(\d+)$/.exec(response.headers.get("content-range") ?? "");
    const expected = range ? Number(range[1]) + 1 : 0;
    const total = range ? Number(range[2]) : 0;
    if (
      response.status !== 206 ||
      !Number.isSafeInteger(total) ||
      expected <= 0 ||
      expected !== Math.min(input.maxBytes, total) ||
      !response.body
    ) {
      await response.body?.cancel();
      throw new Error("storage did not return the bounded prefix");
    }
    const bytes = new Uint8Array(expected);
    const reader = response.body.getReader();
    let offset = 0;
    try {
      while (offset < expected) {
        const { value, done } = await reader.read();
        if (done) throw new Error("truncated storage prefix");
        if (offset + value.length > expected) throw new Error("oversized storage prefix");
        bytes.set(value, offset);
        offset += value.length;
      }
      return bytes;
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  async presignPut(objectKey: string, input: { contentType: string; expiresInSeconds: number }) {
    const headers = { "Content-Type": input.contentType, "x-oss-forbid-overwrite": "true" };
    const url = await this.presignClient.signatureUrlV4(
      "PUT",
      input.expiresInSeconds,
      { headers },
      objectKey,
    );
    return { url, headers };
  }

  async presignGet(objectKey: string, input: { expiresInSeconds: number }) {
    return this.presignClient.signatureUrlV4("GET", input.expiresInSeconds, {}, objectKey);
  }
}

function isMissingObject(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code, status } = error as { code?: unknown; status?: unknown };
  return code === "NoSuchKey" || status === 404;
}
