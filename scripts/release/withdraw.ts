import { parseArgs } from "node:util";
import { ReleaseManifestSchema } from "@coforge/computer/src/updater";
import type OSS from "ali-oss";

import {
  DEFAULT_BUCKET,
  createOssClient,
  DEFAULT_TARGETS,
  verifyPrivateOrigin,
  movePointer,
  ossError,
  readObjectIfPresent,
  type OssConnection,
} from "./publish";

export interface WithdrawalInput {
  version: string;
  manifestSha256: string;
  restoreVersion: string;
  restoreManifestSha256: string;
}

interface WithdrawalContext {
  client: OSS;
  connection: OssConnection;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

function validateSelection(input: WithdrawalInput): void {
  const devVersion = /^\d+\.\d+\.\d+-dev\.[1-9]\d*$/;
  if (
    !devVersion.test(input.version) ||
    !devVersion.test(input.restoreVersion) ||
    input.version === input.restoreVersion
  )
    throw new Error("Select two different numbered development versions");
  if (
    ![input.manifestSha256, input.restoreManifestSha256].every((digest) =>
      /^[0-9a-f]{64}$/.test(digest),
    )
  )
    throw new Error("Both manifest SHA-256 values are required");
}

/** Restore a complete, pinned release before removing the selected version's fixed object set.
 * Callers serialize this with publication using the release-staging workflow concurrency group. */
export async function withdrawStagingRelease(
  input: WithdrawalInput,
  context: WithdrawalContext,
): Promise<{ deleted: string[] }> {
  validateSelection(input);
  const assertLatest = async (allowed: string[]) => {
    const bytes = await readObjectIfPresent(context.client, "latest");
    if (!bytes || !allowed.includes(new TextDecoder().decode(bytes)))
      throw new Error("Unexpected latest; withdrawal stopped");
  };
  await assertLatest([`${input.version}\n`, `${input.restoreVersion}\n`]);
  const manifestKey = `${input.version}/manifest.json`;
  const readManifest = async (version: string, digest: string) => {
    const key = `${version}/manifest.json`;
    const bytes = await readObjectIfPresent(context.client, key);
    if (!bytes) throw new Error(`Missing manifest: ${key}`);
    if (sha256(bytes) !== digest) throw new Error(`Manifest SHA-256 mismatch: ${key}`);
    const manifest = ReleaseManifestSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
    if (
      manifest.version !== version ||
      Object.keys(manifest.platforms).sort().join(",") !== [...DEFAULT_TARGETS].sort().join(",")
    )
      throw new Error(`Manifest must identify ${version} with all six platforms`);
    return manifest;
  };
  const manifest = await readManifest(input.version, input.manifestSha256);
  const previous = await readManifest(input.restoreVersion, input.restoreManifestSha256);
  const verification = {
    connection: context.connection,
    fetchImpl: context.fetchImpl ?? fetch,
    log: context.log ?? (() => undefined),
  };
  const verifyObject = async (key: string, digest: string, size?: number) => {
    const bytes = await readObjectIfPresent(context.client, key);
    if (!bytes || sha256(bytes) !== digest || (size !== undefined && bytes.byteLength !== size))
      throw new Error(`Restore object verification failed: ${key}`);
    await verifyPrivateOrigin(verification, key);
    context.log?.(`verified ${key} sha256=${digest}`);
  };
  await verifyPrivateOrigin(verification, `${input.restoreVersion}/manifest.json`);
  for (const target of DEFAULT_TARGETS) {
    const computer = previous.platforms[target]!.computer;
    const prefix = `${input.restoreVersion}/${target}/coforge-computer`;
    await verifyObject(`${prefix}.gz`, computer.gzip.checksum, computer.gzip.size);
    await verifyObject(
      `${prefix}.sha256`,
      sha256(new TextEncoder().encode(`${computer.checksum}\n`)),
    );
  }
  await verifyObject(
    `${input.restoreVersion}/photon_rs_bg.wasm`,
    previous.photonWasm.checksum,
    previous.photonWasm.size,
  );
  await movePointer({ ...context, version: input.restoreVersion });
  const keys = DEFAULT_TARGETS.flatMap((target) => [
    `${manifest.version}/${target}/coforge-computer.gz`,
    `${manifest.version}/${target}/coforge-computer.sha256`,
  ]);
  keys.push(`${manifest.version}/photon_rs_bg.wasm`, manifestKey);
  const deleted: string[] = [];
  for (const key of keys) {
    await assertLatest([`${input.restoreVersion}\n`]);
    try {
      await context.client.delete(key);
    } catch (error) {
      throw ossError("delete", key, error);
    }
    if (await readObjectIfPresent(context.client, key))
      throw new Error(`Object remains after deletion: ${key}`);
    deleted.push(key);
    context.log?.(`verified absent ${key}`);
  }
  return { deleted };
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({
      args: process.argv.slice(2),
      strict: true,
      allowPositionals: false,
      options: {
        version: { type: "string" },
        "manifest-sha256": { type: "string" },
        "restore-version": { type: "string" },
        "restore-manifest-sha256": { type: "string" },
      },
    });
    const input: WithdrawalInput = {
      version: values.version ?? "",
      manifestSha256: values["manifest-sha256"] ?? "",
      restoreVersion: values["restore-version"] ?? "",
      restoreManifestSha256: values["restore-manifest-sha256"] ?? "",
    };
    validateSelection(input);
    const connection: OssConnection = {
      bucket: DEFAULT_BUCKET,
      endpoint: "oss-accelerate.aliyuncs.com",
      region: "oss-cn-beijing",
      secure: true,
    };
    const client = await createOssClient(connection);
    const result = await withdrawStagingRelease(input, { client, connection, log: console.log });
    console.log(
      `withdrawn ${input.version}; latest=${input.restoreVersion}; verified absent=${result.deleted.length}`,
    );
  } catch (error) {
    console.error(`withdrawal failed: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 1;
  }
}
