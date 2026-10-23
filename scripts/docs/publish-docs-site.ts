#!/usr/bin/env bun
/**
 * Publishes the built public developer docs site (apps/docs `.vitepress/dist`) to the private
 * Alibaba Cloud OSS bucket behind https://docs.coforge.cn. apps/docs/AGENTS.md ("Deployment")
 * describes the bucket, the CDN rewrite rules and the approval gate.
 *
 * Order, so a visitor never meets a page whose assets are missing: every non-HTML object (assets
 * first), then HTML last, then objects the bucket holds that the dist no longer has are deleted
 * (never when the dist is empty or lacks index.html), then verification: an authenticated
 * read-back hash of index.html and llms.txt, and an unsigned GET of the bucket object that must be
 * 403 (the origin stays private; only the CDN reads it).
 *
 * The OSS client and credential chain are the release publisher's (scripts/release/publish.ts):
 * GitHub OIDC -> STS in CI, nothing long-lived. No credential or SDK error text is printed.
 */
import { readdir, readFile } from "node:fs/promises";
import { join, posix, sep } from "node:path";
import { parseArgs } from "node:util";

import type OSS from "ali-oss";

import {
  assertDistUsable,
  cacheControlFor,
  contentTypeFor,
  extensionOf,
  listPageQuery,
  staleKeys,
  uploadOrder,
} from "./site-plan";
import { createOssClient, ossError, type OssConnection } from "../release/publish";

/* -------------------------------------------------------------------------------------------- */
/* I/O                                                                                           */
/* -------------------------------------------------------------------------------------------- */

async function listDist(root: string, dir = ""): Promise<string[]> {
  const entries = await readdir(join(root, dir), { withFileTypes: true });
  const keys: string[] = [];
  for (const entry of entries) {
    const relative = dir ? `${dir}${sep}${entry.name}` : entry.name;
    if (entry.isDirectory()) keys.push(...(await listDist(root, relative)));
    else if (entry.isFile()) keys.push(relative.split(sep).join(posix.sep));
  }
  return keys;
}

async function listBucket(client: OSS): Promise<string[]> {
  const keys: string[] = [];
  let marker: string | undefined;
  try {
    do {
      const page = await client.list(listPageQuery(marker), {});
      for (const object of page.objects ?? []) keys.push(object.name);
      marker = page.isTruncated ? page.nextMarker : undefined;
    } while (marker);
  } catch (error) {
    throw ossError("list", "(bucket)", error);
  }
  return keys;
}

async function forEachLimited<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await work(items[next++] as T);
  });
  await Promise.all(runners);
}

function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

function bucketObjectUrl(connection: OssConnection, key: string): string {
  const url = new URL(`https://${connection.bucket}.${connection.endpoint}`);
  url.pathname = `/${key}`;
  return url.toString();
}

export async function publishDocsSite(options: {
  distDir: string;
  connection: OssConnection;
  log?: (line: string) => void;
}): Promise<void> {
  const log = options.log ?? ((line: string) => console.log(line));
  const distKeys = await listDist(options.distDir);
  assertDistUsable(distKeys);
  const client = await createOssClient(options.connection);

  const ordered = uploadOrder(distKeys);
  const bytesByKey = new Map<string, Uint8Array>();
  // Tiers are sequential (assets, then other files, then HTML); objects within a tier go in parallel.
  const tiers = [
    ordered.filter((key) => key.startsWith("assets/")),
    ordered.filter((key) => !key.startsWith("assets/") && extensionOf(key) !== "html"),
    ordered.filter((key) => !key.startsWith("assets/") && extensionOf(key) === "html"),
  ];
  for (const tier of tiers) {
    await forEachLimited(tier, 8, async (key) => {
      const bytes = new Uint8Array(await readFile(join(options.distDir, key)));
      bytesByKey.set(key, bytes);
      try {
        await client.put(key, Buffer.from(bytes), {
          headers: { "Content-Type": contentTypeFor(key), "Cache-Control": cacheControlFor(key) },
        });
      } catch (error) {
        throw ossError("upload", key, error);
      }
    });
    log(`uploaded ${tier.length} object(s)`);
  }

  const stale = staleKeys(await listBucket(client), distKeys);
  for (let start = 0; start < stale.length; start += 1000) {
    const chunk = stale.slice(start, start + 1000);
    try {
      await client.deleteMulti(chunk, { quiet: true });
    } catch (error) {
      throw ossError("delete", chunk[0] ?? "(none)", error);
    }
  }
  log(`deleted ${stale.length} stale object(s)`);

  for (const key of ["index.html", "llms.txt"]) {
    const local = bytesByKey.get(key);
    if (!local) throw new Error(`dist has no ${key}; cannot verify`);
    let remote: Uint8Array;
    try {
      remote = new Uint8Array((await client.get(key)).content as Buffer);
    } catch (error) {
      throw ossError("read-back", key, error);
    }
    if (sha256(remote) !== sha256(local)) throw new Error(`read-back mismatch: ${key}`);
    log(`verified ${key} sha256=${sha256(local)}`);
  }

  const response = await fetch(bucketObjectUrl(options.connection, "index.html"), {
    method: "GET",
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });
  await response.body?.cancel();
  if (response.status !== 403) throw new Error("Private origin verification failed: index.html");
  log("verified private origin index.html");
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      dist: { type: "string" },
      bucket: { type: "string" },
      endpoint: { type: "string" },
      region: { type: "string" },
    },
    strict: true,
  });
  if (!values.dist || !values.bucket || !values.endpoint || !values.region) {
    console.error("usage: publish-docs-site.ts --dist DIR --bucket B --endpoint E --region R");
    process.exit(2);
  }
  try {
    await publishDocsSite({
      distDir: values.dist,
      connection: { bucket: values.bucket, endpoint: values.endpoint, region: values.region },
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : "publish failed");
    process.exit(1);
  }
}
