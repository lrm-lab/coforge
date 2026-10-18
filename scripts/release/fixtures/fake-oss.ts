import type { OssConnection, OssCredentials } from "../publish";

/** The bucket, region and credentials every publish test signs with. The fixture host names no
 * region, so tests pass one explicitly; the real bucket's region is derived from its endpoint (see
 * publish.test.ts's `regionFromEndpoint` test). */
export const CREDENTIALS: OssCredentials = {
  accessKeyId: "testkey",
  accessKeySecret: "testsecret",
};
export const BUCKET = "coforge-releases-test";
export const REGION = "oss-cn-beijing";

const servers: Array<ReturnType<typeof Bun.serve>> = [];

/** Stops every fake server started since the last call; a test file calls it in `afterEach`. */
export function stopFakeOssServers(): void {
  for (const server of servers.splice(0)) server.stop(true);
}

/** A fake OSS origin. It does not attempt to re-verify the V4 signature ali-oss puts on every
 * authenticated request - that is the SDK's responsibility, not this script's, so there is
 * nothing left here to pin against. It still distinguishes an authenticated call (has an
 * `authorization` header) from the anonymous ones `verifyPrivateOrigin` makes on purpose, since
 * that distinction is publish.ts's own behavior. */
export interface FakeOssOptions {
  failUploadKeys?: Set<string>;
  failDeleteKeys?: Set<string>;
  retainDeleteKeys?: Set<string>;
  tamperReadbackKeys?: Set<string>;
  publicOriginKeys?: Set<string>;
  previousLatest?: string;
  /** Objects that already exist in the bucket before the publish starts. */
  preexistingKeys?: Set<string>;
  /** Objects that already exist, with their text content (the installer feed's pointer and
   * manifests). A tampered read-back leaves a key alone while it still holds this content, which is
   * how a rollback that restores it verifies. */
  preexistingObjects?: Record<string, string>;
  /** Keys whose existence probe answers with an ambiguous status instead of 200/404. */
  failProbeKeys?: Set<string>;
  /** Delay every authenticated upload response by this many ms, simulating a slow link. Used by
   * the slow-server regression test to prove a stalled upload reports the timeout's `name`. */
  delayUploadMs?: number;
}

export interface FakeOss {
  baseUrl: string;
  calls: Array<{ method: string; key: string }>;
  /** The `authorization` header value ali-oss sent with each entry in `calls`, in the same order
   * (`undefined` for the anonymous `ANONYMOUS_GET` calls). */
  authHeaders: Array<string | undefined>;
  /** Reads the fixture's in-memory store directly, bypassing HTTP - used to assert the final
   * state of `latest` after a rollback without needing a second signed client round trip. */
  peek(key: string): Uint8Array | undefined;
  /** The `Content-Type` header the most recent PUT for this key carried, or undefined if it was
   * never uploaded. */
  contentType(key: string): string | undefined;
}

export function startFakeOssServer(options: FakeOssOptions = {}): FakeOss {
  const store = new Map<string, Uint8Array>();
  for (const key of options.preexistingKeys ?? []) store.set(key, new Uint8Array([0x7b, 0x7d]));
  if (options.previousLatest) store.set("latest", new TextEncoder().encode(options.previousLatest));
  for (const [key, text] of Object.entries(options.preexistingObjects ?? {}))
    store.set(key, new TextEncoder().encode(text));
  const calls: Array<{ method: string; key: string }> = [];
  const authHeaders: Array<string | undefined> = [];
  const contentTypes = new Map<string, string | undefined>();

  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const objectKey = url.pathname.slice(1);
      const method = request.method;
      const authorization = request.headers.get("authorization") ?? undefined;
      const anonymous = method === "GET" && !authorization;
      calls.push({ method: anonymous ? "ANONYMOUS_GET" : method, key: objectKey });
      authHeaders.push(authorization);

      if (anonymous) {
        return new Response("origin", {
          status: options.publicOriginKeys?.has(objectKey) ? 200 : 403,
        });
      }

      if (method === "DELETE") {
        if (options.failDeleteKeys?.has(objectKey))
          return new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 });
        if (!options.retainDeleteKeys?.has(objectKey)) store.delete(objectKey);
        return new Response(null, { status: 204 });
      }
      if (method === "PUT") {
        if (options.delayUploadMs) {
          await Bun.sleep(options.delayUploadMs);
        }
        if (options.failUploadKeys?.has(objectKey)) {
          return new Response("<Error><Code>InternalError</Code></Error>", {
            status: 500,
            headers: { "x-oss-request-id": "fake-request-id-upload-fail" },
          });
        }
        store.set(objectKey, new Uint8Array(await request.arrayBuffer()));
        contentTypes.set(objectKey, request.headers.get("content-type") ?? undefined);
        return new Response(null, { status: 200 });
      }

      if (method === "HEAD") {
        if (options.failProbeKeys?.has(objectKey)) {
          return new Response(null, {
            status: 403,
            headers: { "x-oss-request-id": "fake-request-id-probe-fail" },
          });
        }
        return new Response(null, { status: store.has(objectKey) ? 200 : 404 });
      }

      if (method === "GET") {
        const stored = store.get(objectKey);
        if (!stored) {
          return new Response("<Error><Code>NoSuchKey</Code></Error>", {
            status: 404,
            headers: { "x-oss-request-id": "fake-request-id-missing" },
          });
        }
        const restorable =
          objectKey === "latest" ? options.previousLatest : options.preexistingObjects?.[objectKey];
        if (
          options.tamperReadbackKeys?.has(objectKey) &&
          new TextDecoder().decode(stored) !== restorable
        ) {
          const tampered = new Uint8Array(stored.byteLength + 1);
          tampered.set(stored);
          tampered[stored.byteLength] = 0xff;
          return new Response(tampered);
        }
        return new Response(stored);
      }

      return new Response("method not allowed", { status: 405 });
    },
  });
  servers.push(server);
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    calls,
    authHeaders,
    peek: (key) => store.get(key),
    contentType: (key) => contentTypes.get(key),
  };
}

/** A fixture endpoint reached like the real bucket - direct HTTP to the fake server's host, no
 * bucket-name-prefixed virtual hosting (`cname: true`), over plain HTTP (`secure: false`). */
export function fixtureConnection(fake: FakeOss, bucket = BUCKET): OssConnection {
  return { bucket, endpoint: fake.baseUrl, region: REGION, cname: true, secure: false };
}
