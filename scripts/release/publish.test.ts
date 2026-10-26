import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type OSS from "ali-oss";

import { buildReleaseTree, type ReleaseInputs, type ReleaseTree } from "./build-release";
import type { ReleaseTarget } from "./compile-targets";
import {
  BUCKET,
  CREDENTIALS,
  REGION,
  fixtureConnection,
  startFakeOssServer,
  startLeakFixtureServer,
  stopFakeOssServers,
} from "./fixtures/fake-oss";
import {
  assertVersionIsUnpublished,
  createOssClient,
  regionFromEndpoint,
  LATEST_OBJECT_KEY,
  manifestObjectKey,
  movePointer,
  nextDevVersion,
  ossError,
  parseTargets,
  runCli,
  runPublish,
  uploadReleaseTree,
  type CompileFn,
  type PublishDependencies,
  type PublishOptions,
} from "./publish";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  stopFakeOssServers();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function tempDir(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

// `windows-x64` sorts after "manifest.json", which is what makes the manifest-last upload order
// load-bearing: with only POSIX targets (all sorting before `m`) `tree.files` already ends with
// the manifest, and reverting publish.ts to upload in plain `tree.files` order passes every test
// here. Compilation is stubbed, so the extra target costs nothing.
const TEST_TARGETS = ["linux-x64", "linux-arm64", "windows-x64"];

function fixtureArtifacts(): Record<string, { computer: Uint8Array }> {
  const artifacts: Record<string, { computer: Uint8Array }> = {};
  for (const target of TEST_TARGETS) {
    artifacts[target] = {
      computer: Buffer.from(`#!/bin/sh\n# unified computer for ${target}\n`),
    };
  }
  return artifacts;
}

/** A small, distinct fixture standing in for the real ~1.8 MB `photon_rs_bg.wasm` - resolving the
 * real file from the installed dependency chain is photon-wasm.test.ts's concern. */
const FIXTURE_PHOTON_WASM = new Uint8Array(Buffer.from("#wasm-fixture: photon_rs_bg.wasm\n"));

function stubResolvePhotonWasm(): () => Promise<Uint8Array> {
  return async () => FIXTURE_PHOTON_WASM;
}

async function fixtureTree(version: string, outputDirectory: string): Promise<ReleaseTree> {
  const inputs: ReleaseInputs = {
    version,
    commit: "a".repeat(40),
    buildDate: new Date("2026-09-01T00:00:00.000Z").toISOString(),
    artifacts: fixtureArtifacts(),
    photonWasm: FIXTURE_PHOTON_WASM,
  };
  return buildReleaseTree(inputs, outputDirectory);
}

function stubCompile(): CompileFn {
  const artifacts = fixtureArtifacts();
  return (async ({ target }) => {
    const fixture = artifacts[target];
    if (!fixture) throw new Error(`no fixture artifact for target: ${target}`);
    return fixture;
  }) as CompileFn;
}

/* ------------------------------------------------------------------------------------------- */
/* 1. Ordering: latest is written last, and only after every object is verified                 */
/* ------------------------------------------------------------------------------------------- */

test("publication uploads every object, verifies it by reading the bytes back, and writes latest last", async () => {
  const outputDirectory = await tempDir("coforge-publish-tree-");
  const tree = await fixtureTree("9.9.9-publish-ok", outputDirectory);
  const fake = startFakeOssServer();
  const connection = fixtureConnection(fake);
  const client: OSS = await createOssClient(connection, CREDENTIALS);

  const result = await uploadReleaseTree(outputDirectory, tree, { client, connection });

  expect(result.latestKey).toBe(LATEST_OBJECT_KEY);
  expect(result.uploaded).toEqual(tree.files);

  // The manifest is uploaded last, after every binary, so that its presence means "this version
  // is complete" - which is exactly what the republish guard's HEAD probe reads.
  const manifestKey = manifestObjectKey(tree.version);
  const expectedSequence = [
    { method: "HEAD", key: manifestKey },
    // The forward-only gate reads `latest` before anything goes up.
    { method: "GET", key: LATEST_OBJECT_KEY },
    ...tree.files.filter((key) => key !== manifestKey).map((key) => ({ method: "PUT", key })),
    { method: "PUT", key: manifestKey },
    ...tree.files.map((key) => ({ method: "GET", key })),
    ...tree.files.map((key) => ({ method: "ANONYMOUS_GET", key })),
    { method: "HEAD", key: LATEST_OBJECT_KEY },
    { method: "PUT", key: LATEST_OBJECT_KEY },
    { method: "GET", key: LATEST_OBJECT_KEY },
    { method: "ANONYMOUS_GET", key: LATEST_OBJECT_KEY },
  ];
  expect(fake.calls).toEqual(expectedSequence);

  const latestPutIndex = fake.calls.findIndex(
    (call) => call.method === "PUT" && call.key === LATEST_OBJECT_KEY,
  );
  for (const call of fake.calls) {
    if (call.key === LATEST_OBJECT_KEY) continue;
    expect(fake.calls.indexOf(call)).toBeLessThan(latestPutIndex);
  }

  // Every authenticated request is V4-signed by the SDK; the anonymous origin-privacy probes
  // publish.ts makes on purpose carry no Authorization header at all.
  fake.calls.forEach((call, index) => {
    if (call.method === "ANONYMOUS_GET") {
      expect(fake.authHeaders[index]).toBeUndefined();
    } else {
      // The credential scope names the bucket's region: OSS rejects a scope for another region
      // with InvalidArgument, which is exactly what happened when the client defaulted to
      // ali-oss's oss-cn-hangzhou.
      expect(fake.authHeaders[index]).toMatch(
        /^OSS4-HMAC-SHA256 Credential=testkey\/\d{8}\/cn-beijing\/oss\/aliyun_v4_request,/,
      );
    }
  });

  // The bytes actually landed, not only that the SDK reported success.
  const roundTrip = await client.get(manifestKey);
  const local = await readFile(join(outputDirectory, manifestKey));
  expect(Buffer.compare(roundTrip.content as Buffer, local)).toBe(0);
});

test("photon_rs_bg.wasm uploads with the application/wasm media type; every other object stays octet-stream", async () => {
  const outputDirectory = await tempDir("coforge-publish-tree-");
  const tree = await fixtureTree("9.9.9-wasm-content-type", outputDirectory);
  const wasmKey = `${tree.version}/photon_rs_bg.wasm`;
  const manifestKey = manifestObjectKey(tree.version);
  const fake = startFakeOssServer();
  const connection = fixtureConnection(fake);
  const client = await createOssClient(connection, CREDENTIALS);

  await uploadReleaseTree(outputDirectory, tree, { client, connection });

  expect(fake.contentType(wasmKey)).toBe("application/wasm");
  expect(fake.contentType(manifestKey)).toBe("application/octet-stream");
  for (const target of TEST_TARGETS) {
    expect(fake.contentType(`${tree.version}/${target}/coforge-computer.gz`)).toBe(
      "application/octet-stream",
    );
  }
});

test("a failed object upload never writes latest, and stops before uploading later objects", async () => {
  const outputDirectory = await tempDir("coforge-publish-tree-");
  const tree = await fixtureTree("9.9.9-upload-fail", outputDirectory);
  // Fail the first object actually uploaded - the manifest is deferred to last, so it is not it.
  const failingKey = tree.files.find((key) => key !== manifestObjectKey(tree.version));
  if (!failingKey) throw new Error("fixture tree produced no files");
  const fake = startFakeOssServer({ failUploadKeys: new Set([failingKey]) });
  const connection = fixtureConnection(fake);
  const client = await createOssClient(connection, CREDENTIALS);

  await expect(uploadReleaseTree(outputDirectory, tree, { client, connection })).rejects.toThrow(
    /OSS upload failed: HTTP 500/,
  );

  expect(fake.calls).toEqual([
    { method: "HEAD", key: manifestObjectKey(tree.version) },
    { method: "GET", key: LATEST_OBJECT_KEY },
    { method: "PUT", key: failingKey },
  ]);
  // A publish that dies mid-upload must not leave the manifest behind, or the version would be
  // permanently burned by its own failure instead of being retryable.
  expect(
    fake.calls.some((call) => call.method === "PUT" && call.key.endsWith("manifest.json")),
  ).toBe(false);
  expect(fake.calls.some((call) => call.method === "PUT" && call.key === LATEST_OBJECT_KEY)).toBe(
    false,
  );
});

test("a stalled upload reports the timeout's name, not an opaque HTTP unknown", async () => {
  const outputDirectory = await tempDir("coforge-publish-slowtimeout-");
  const tree = await fixtureTree("9.9.9-slow-timeout", outputDirectory);
  // The fixture never responds within the test's tiny per-request timeout, so ali-oss aborts the
  // request with a name-only ResponseTimeoutError (no status/code/request-id - see publish.ts's
  // ossError comment). This pins the regression: the message has to say *which* failure it was.
  const fake = startFakeOssServer({ delayUploadMs: 500 });
  const connection = fixtureConnection(fake);
  const client = await createOssClient(connection, CREDENTIALS);

  const rejection = await uploadReleaseTree(outputDirectory, tree, {
    client,
    connection,
    requestTimeoutMs: 50,
  }).catch((error: unknown) => error as Error);
  expect(rejection).toBeInstanceOf(Error);
  expect(rejection.message).toMatch(/OSS upload failed:/);
  // The timeout surfaces its stable class name, so the log can say "it timed out" rather than
  // leaving a bare `HTTP unknown` that is indistinguishable from any other opaque transport error.
  expect(rejection.message).toMatch(/ResponseTimeoutError/);

  // A failed publish must not have advanced `latest` or left the manifest behind.
  expect(fake.calls.some((call) => call.method === "PUT" && call.key === LATEST_OBJECT_KEY)).toBe(
    false,
  );
  expect(
    fake.calls.some((call) => call.method === "PUT" && call.key.endsWith("manifest.json")),
  ).toBe(false);
});

test("republishing a version that already completed is refused before anything is uploaded", async () => {
  const outputDirectory = await tempDir("coforge-publish-republish-");
  const tree = await fixtureTree("9.9.9-already-live", outputDirectory);
  const fake = startFakeOssServer({
    preexistingKeys: new Set([manifestObjectKey(tree.version)]),
  });
  const connection = fixtureConnection(fake);
  const client = await createOssClient(connection, CREDENTIALS);

  await expect(uploadReleaseTree(outputDirectory, tree, { client, connection })).rejects.toThrow(
    /9\.9\.9-already-live is already published/,
  );

  // The point of the guard is that a live version's bytes are never touched: the CDN caches
  // `<version>/*` for a year, so a second publish would leave different bytes on different edges.
  expect(fake.calls).toEqual([{ method: "HEAD", key: manifestObjectKey(tree.version) }]);
});

test("a publication never moves latest back: an older version is refused before anything is uploaded", async () => {
  const outputDirectory = await tempDir("coforge-publish-backwards-");
  const tree = await fixtureTree("0.1.4", outputDirectory);
  const fake = startFakeOssServer({ previousLatest: "0.1.5-dev.2\n" });
  const connection = fixtureConnection(fake);
  const client = await createOssClient(connection, CREDENTIALS);

  await expect(uploadReleaseTree(outputDirectory, tree, { client, connection })).rejects.toThrow(
    /0\.1\.4 is older than the feed's latest 0\.1\.5-dev\.2/,
  );
  expect(fake.calls.filter((call) => call.method === "PUT")).toEqual([]);
  expect(new TextDecoder().decode(fake.peek(LATEST_OBJECT_KEY))).toBe("0.1.5-dev.2\n");
});

test("a finalize rerun of the version latest already names is not a move back", async () => {
  const outputDirectory = await tempDir("coforge-publish-finalize-rerun-");
  const tree = await fixtureTree("0.1.5", outputDirectory);
  const fake = startFakeOssServer({});
  const connection = fixtureConnection(fake);
  const client = await createOssClient(connection, CREDENTIALS);
  await uploadReleaseTree(outputDirectory, tree, { client, connection });

  await uploadReleaseTree(outputDirectory, tree, { client, connection, allowExisting: true });

  expect(new TextDecoder().decode(fake.peek(LATEST_OBJECT_KEY))).toBe("0.1.5\n");
});

test("moving a pointer back on purpose (withdrawal, pointer_only) is not a publication", async () => {
  const fake = startFakeOssServer({
    previousLatest: "0.1.5\n",
    preexistingObjects: { "0.1.4/manifest.json": "{}" },
  });
  const connection = fixtureConnection(fake);
  const client = await createOssClient(connection, CREDENTIALS);

  await movePointer({ client, connection, version: "0.1.4" });

  expect(new TextDecoder().decode(fake.peek(LATEST_OBJECT_KEY))).toBe("0.1.4\n");
});

test("a version left half-uploaded by an earlier failure can still be published", async () => {
  const outputDirectory = await tempDir("coforge-publish-retry-");
  const tree = await fixtureTree("9.9.9-retry-ok", outputDirectory);
  // A partial publish uploaded some binaries but never reached the manifest, which is exactly
  // what the manifest-last ordering guarantees. That version must remain publishable.
  const partial = tree.files.find((key) => key !== manifestObjectKey(tree.version));
  if (!partial) throw new Error("fixture tree produced no files");
  const fake = startFakeOssServer({ preexistingKeys: new Set([partial]) });
  const connection = fixtureConnection(fake);
  const client = await createOssClient(connection, CREDENTIALS);

  const result = await uploadReleaseTree(outputDirectory, tree, { client, connection });

  expect(result.latestKey).toBe(LATEST_OBJECT_KEY);
});

test("an ambiguous existence probe aborts the publish instead of reading as absent", async () => {
  const outputDirectory = await tempDir("coforge-publish-probe-fail-");
  const tree = await fixtureTree("9.9.9-probe-fail", outputDirectory);
  const fake = startFakeOssServer({
    failProbeKeys: new Set([manifestObjectKey(tree.version)]),
  });
  const connection = fixtureConnection(fake);
  const client = await createOssClient(connection, CREDENTIALS);

  // A 403 must not be mistaken for "not published yet" - that would overwrite a live version on a
  // transient credential or permission fault.
  await expect(uploadReleaseTree(outputDirectory, tree, { client, connection })).rejects.toThrow(
    /OSS probe failed: HTTP 403/,
  );

  expect(fake.calls.every((call) => call.method === "HEAD")).toBe(true);
});

test("assertVersionIsUnpublished resolves for a version the feed has never seen", async () => {
  const fake = startFakeOssServer();
  const connection = fixtureConnection(fake);
  const client = await createOssClient(connection, CREDENTIALS);

  await assertVersionIsUnpublished("1.2.3-fresh", { client });

  expect(fake.calls).toEqual([{ method: "HEAD", key: "1.2.3-fresh/manifest.json" }]);
});

test("the first staging build of a release line is its dev.1", async () => {
  const fake = startFakeOssServer();
  const client = await createOssClient(fixtureConnection(fake), CREDENTIALS);

  expect(await nextDevVersion("0.1.1", { client })).toBe("0.1.1-dev.1");
});

test("a release line takes the smallest dev number the feed has not published, not max + 1", async () => {
  // 0.1.1-dev.82 was published under the old run-number naming before per-line numbering began.
  const fake = startFakeOssServer({
    preexistingKeys: new Set([
      manifestObjectKey("0.1.1-dev.1"),
      manifestObjectKey("0.1.1-dev.82"),
      manifestObjectKey("0.1.0-dev.2"),
    ]),
  });
  const client = await createOssClient(fixtureConnection(fake), CREDENTIALS);

  expect(await nextDevVersion("0.1.1", { client })).toBe("0.1.1-dev.2");
});

test("a release line's search starts at the number it is given, skipping the unused ones below it", async () => {
  const fake = startFakeOssServer({
    preexistingKeys: new Set([manifestObjectKey("0.1.5-dev.1"), manifestObjectKey("0.1.5-dev.4")]),
  });
  const client = await createOssClient(fixtureConnection(fake), CREDENTIALS);

  expect(await nextDevVersion("0.1.5", { client, from: 5 })).toBe("0.1.5-dev.5");
  expect(await nextDevVersion("0.1.5", { client })).toBe("0.1.5-dev.2");
});

test("a dev number left half-uploaded by a failed publish is reused, as a rerun would", async () => {
  const fake = startFakeOssServer({
    preexistingKeys: new Set(["0.1.1-dev.1/linux-x64/coforge-computer.gz"]),
  });
  const client = await createOssClient(fixtureConnection(fake), CREDENTIALS);

  expect(await nextDevVersion("0.1.1", { client })).toBe("0.1.1-dev.1");
});

test("an ambiguous probe stops the dev-number search instead of reading as unused", async () => {
  const fake = startFakeOssServer({
    preexistingKeys: new Set([manifestObjectKey("0.1.1-dev.1")]),
    failProbeKeys: new Set([manifestObjectKey("0.1.1-dev.2")]),
  });
  const client = await createOssClient(fixtureConnection(fake), CREDENTIALS);

  await expect(nextDevVersion("0.1.1", { client })).rejects.toThrow(/OSS probe failed: HTTP 403/);
});

test("the dev-number search gives up after 500 numbers instead of probing forever", async () => {
  const published = Array.from({ length: 500 }, (_, index) =>
    manifestObjectKey(`0.1.1-dev.${index + 1}`),
  );
  const fake = startFakeOssServer({ preexistingKeys: new Set(published) });
  const client = await createOssClient(fixtureConnection(fake), CREDENTIALS);

  await expect(nextDevVersion("0.1.1", { client })).rejects.toThrow(
    /0\.1\.1 has no unused dev number up to 500/,
  );
});

/* ------------------------------------------------------------------------------------------- */
/* 2. Read-back verification                                                                     */
/* ------------------------------------------------------------------------------------------- */

test("a tampered read-back fails the publish and never writes latest", async () => {
  const outputDirectory = await tempDir("coforge-publish-tree-");
  const tree = await fixtureTree("9.9.9-readback-fail", outputDirectory);
  const tamperedKey = tree.files.find((file) => file.endsWith("manifest.json"));
  if (!tamperedKey) throw new Error("fixture tree has no manifest.json");
  const fake = startFakeOssServer({ tamperReadbackKeys: new Set([tamperedKey]) });
  const connection = fixtureConnection(fake);
  const client = await createOssClient(connection, CREDENTIALS);

  await expect(uploadReleaseTree(outputDirectory, tree, { client, connection })).rejects.toThrow(
    /OSS read-back mismatch: .*manifest\.json/,
  );

  expect(fake.calls.some((call) => call.method === "PUT" && call.key === LATEST_OBJECT_KEY)).toBe(
    false,
  );
  // Every object was still uploaded before the mismatch was caught - only the read-back phase,
  // which runs after every upload, is where this fails.
  expect(
    fake.calls.filter((call) => call.method === "PUT" && call.key !== LATEST_OBJECT_KEY).length,
  ).toBe(tree.files.length);
});

/* ------------------------------------------------------------------------------------------- */
/* 3. Private-origin gate and rollback                                                           */
/* ------------------------------------------------------------------------------------------- */

test("public origin blocks activation even after signed OSS verification succeeds", async () => {
  const directory = await tempDir("coforge-delivery-gate-");
  const tree = await fixtureTree("9.9.9-delivery-gate", directory);
  const key = manifestObjectKey(tree.version);
  const fake = startFakeOssServer({ publicOriginKeys: new Set([key]) });
  const connection = fixtureConnection(fake);
  const client = await createOssClient(connection, CREDENTIALS);

  await expect(uploadReleaseTree(directory, tree, { client, connection })).rejects.toThrow(
    /Private origin verification failed/,
  );
  expect(fake.calls).toContainEqual({ method: "GET", key });
  expect(fake.calls.some((call) => call.method === "PUT" && call.key === "latest")).toBe(false);
});

for (const previousLatest of ["0.1.0-rc.3\n", undefined]) {
  test(`latest OSS read-back failure restores ${previousLatest ? "previous version" : "empty bootstrap"}`, async () => {
    const directory = await tempDir("coforge-selector-gate-");
    const tree = await fixtureTree("9.9.9-selector.gate", directory);
    const fake = startFakeOssServer({
      previousLatest,
      tamperReadbackKeys: new Set(["latest"]),
    });
    const connection = fixtureConnection(fake);
    const client = await createOssClient(connection, CREDENTIALS);

    await expect(uploadReleaseTree(directory, tree, { client, connection })).rejects.toThrow(
      /activation failed.*restored/,
    );

    const restored = fake.peek(LATEST_OBJECT_KEY);
    if (previousLatest) {
      expect(restored && new TextDecoder().decode(restored)).toBe(previousLatest);
    } else {
      expect(restored).toBeUndefined();
    }
  });
}

test("private origin network failures are sanitized", async () => {
  const directory = await tempDir("coforge-origin-error-");
  const tree = await fixtureTree("9.9.9-origin-error", directory);
  const fake = startFakeOssServer();
  const connection = fixtureConnection(fake);
  const client = await createOssClient(connection, CREDENTIALS);

  await expect(
    uploadReleaseTree(directory, tree, {
      client,
      connection,
      fetchImpl: async (input, init) => {
        if (init?.credentials === "omit") throw new Error("secret origin URL Authorization token");
        return fetch(input, init);
      },
    }),
  ).rejects.toThrow(/^Private origin verification failed: 9\.9\.9-origin-error\//);
  expect(fake.calls.some((call) => call.method === "PUT" && call.key === "latest")).toBe(false);
});

test("public activated and restored latest fails private origin verification", async () => {
  const directory = await tempDir("coforge-latest-origin-");
  const tree = await fixtureTree("9.9.9-latest.origin", directory);
  const fake = startFakeOssServer({ previousLatest: "0.1.0-rc.3\n" });
  const connection = fixtureConnection(fake);
  const client = await createOssClient(connection, CREDENTIALS);
  let probes = 0;

  await expect(
    uploadReleaseTree(directory, tree, {
      client,
      connection,
      fetchImpl: async (input, init) => {
        if (String(input).endsWith("/latest") && init?.credentials === "omit") {
          probes += 1;
          if (probes > 1) return new Response("public", { status: 200 });
        }
        return fetch(input, init);
      },
    }),
  ).rejects.toThrow(/rollback could not be verified/);
  expect(probes).toBe(3);
});

test("rollback failure is reported instead of claiming the previous selector is restored", async () => {
  const directory = await tempDir("coforge-rollback-failure-");
  const tree = await fixtureTree("9.9.9-rollback.failure", directory);
  const fake = startFakeOssServer({
    previousLatest: "0.1.0-rc.3\n",
    failUploadKeys: new Set(["latest"]),
  });
  const connection = fixtureConnection(fake);
  const client = await createOssClient(connection, CREDENTIALS);

  await expect(uploadReleaseTree(directory, tree, { client, connection })).rejects.toThrow(
    /rollback could not be verified/,
  );
});

/* ------------------------------------------------------------------------------------------- */
/* 4. Credential redaction                                                                       */
/* ------------------------------------------------------------------------------------------- */

test("a failed publish never prints the access key, secret, or an Authorization header value", async () => {
  const version = "9.9.9-leak-check";
  const wrongSecret = "not-the-real-secret";
  // A real OSS `SignatureDoesNotMatch` body echoes back `StringToSign`, the supplied
  // `Signature`/`Authorization`, and the `AccessKeyId` - the kind of response this test proves
  // publish.ts never surfaces, whether or not the credentials were actually wrong (the SDK's own
  // V4 signing is out of scope here).
  const leakBody =
    `<Error><Code>SignatureDoesNotMatch</Code>` +
    `<AccessKeyId>${CREDENTIALS.accessKeyId}</AccessKeyId>` +
    `<StringToSign>fake-string-to-sign</StringToSign>` +
    `<AuthorizationProvided>OSS4-HMAC-SHA256 Credential=${CREDENTIALS.accessKeyId},Signature=deadbeef</AuthorizationProvided>` +
    `<Message>wrong secret ${wrongSecret}</Message></Error>`;
  const fake = startLeakFixtureServer(leakBody);

  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => stdout.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => stderr.push(args.map(String).join(" "));

  const previousEnv = {
    id: process.env.ALIBABA_CLOUD_ACCESS_KEY_ID,
    secret: process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET,
  };
  process.env.ALIBABA_CLOUD_ACCESS_KEY_ID = CREDENTIALS.accessKeyId;
  process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET = wrongSecret;

  let exitCode: number;
  try {
    exitCode = await runCli(
      [
        "--version",
        version,
        "--feed-url",
        "https://releases-test.coforge.cn",
        "--bucket",
        BUCKET,
        "--targets",
        TEST_TARGETS.join(","),
        "--commit",
        "a".repeat(40),
      ],
      {
        compile: stubCompile(),
        resolvePhotonWasm: stubResolvePhotonWasm(),
        connection: { endpoint: fake.baseUrl, cname: true, secure: false },
      },
    );
  } finally {
    console.log = originalLog;
    console.error = originalError;
    restoreEnvVar("ALIBABA_CLOUD_ACCESS_KEY_ID", previousEnv.id);
    restoreEnvVar("ALIBABA_CLOUD_ACCESS_KEY_SECRET", previousEnv.secret);
  }

  expect(exitCode).toBe(1);
  const combined = [...stdout, ...stderr].join("\n");
  expect(combined).not.toContain(wrongSecret);
  expect(combined).not.toContain(CREDENTIALS.accessKeySecret);
  // The key id is not a secret the way the secret is, but a real OSS error body echoes it back
  // alongside StringToSign, so printing one is the same mistake as printing the other.
  expect(combined).not.toContain(CREDENTIALS.accessKeyId);
  expect(combined.toLowerCase()).not.toContain("authorization");
  expect(combined).not.toContain("StringToSign");
});

function restoreEnvVar(name: string, previous: string | undefined): void {
  if (previous === undefined) delete process.env[name];
  else process.env[name] = previous;
}

/* ------------------------------------------------------------------------------------------- */
/* 5. Dry run                                                                                     */
/* ------------------------------------------------------------------------------------------- */

test("--dry-run makes no network calls and reports the objects it would publish", async () => {
  let fetchCalls = 0;
  const throwingFetch: typeof fetch = (() => {
    fetchCalls += 1;
    throw new Error("dry-run must never call fetch");
  }) as typeof fetch;

  const outcome = await runPublish(
    {
      version: "9.9.9-dry-run",
      commit: "a".repeat(40),
      feedUrl: "https://releases-test.coforge.cn",
      targets: TEST_TARGETS as ReleaseTarget[],
      bucket: BUCKET,
      endpoint: "oss-cn-beijing.aliyuncs.com",
      dryRun: true,
    },
    {
      compile: stubCompile(),
      resolvePhotonWasm: stubResolvePhotonWasm(),
      fetchImpl: throwingFetch,
    },
  );

  expect(fetchCalls).toBe(0);
  expect(outcome.dryRun).toBe(true);
  expect(outcome.version).toBe("9.9.9-dry-run");
  expect(outcome.files).toContain("9.9.9-dry-run/manifest.json");
  expect(outcome.files).toContain("9.9.9-dry-run/linux-x64/coforge-computer.gz");
  expect(outcome.files).toContain("9.9.9-dry-run/linux-x64/coforge-computer.sha256");
  expect(outcome.files).not.toContain("9.9.9-dry-run/linux-x64/coforge-computer");
  expect(outcome.files.some((file) => file.includes("coforge-daemon"))).toBe(false);
  expect(outcome.latestKey).toBe(LATEST_OBJECT_KEY);
});

const PRODUCTION_FEED = "https://releases-production-test.coforge.cn";

/** Answers production's `latest` with `productionLatest`, and hands every other request - the
 * anonymous private-origin checks - to the real fetch, which reaches the fake OSS. */
function productionFeed(productionLatest: string): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) =>
    String(input) === `${PRODUCTION_FEED}/latest`
      ? new Response(productionLatest)
      : fetch(input, init)) as typeof fetch;
}

/** A staging publication numbered against the production feed `fetchImpl` answers. */
async function publishStagingBuild(
  fake: ReturnType<typeof startFakeOssServer>,
  fetchImpl: typeof fetch,
  options: Partial<PublishOptions> = {},
) {
  const compiledVersions = new Set<string>();
  const compile = stubCompile();
  const outcome = await runPublish(
    {
      productionFeedUrl: PRODUCTION_FEED,
      commit: "a".repeat(40),
      feedUrl: "https://releases-test.coforge.cn",
      targets: TEST_TARGETS as ReleaseTarget[],
      bucket: BUCKET,
      endpoint: fake.baseUrl,
      region: REGION,
      dryRun: false,
      ...options,
    },
    {
      compile: (async (input) => {
        compiledVersions.add(input.version);
        return compile(input);
      }) as CompileFn,
      resolvePhotonWasm: stubResolvePhotonWasm(),
      credentials: CREDENTIALS,
      connection: { endpoint: fake.baseUrl, cname: true, secure: false },
      fetchImpl,
    },
  );
  return { outcome, compiledVersions: [...compiledVersions] };
}

const stagingLatest = (fake: ReturnType<typeof startFakeOssServer>) =>
  new TextDecoder().decode(fake.peek(LATEST_OBJECT_KEY)).trim();
const uploads = (fake: ReturnType<typeof startFakeOssServer>) =>
  fake.calls.filter((call) => call.method === "PUT");

test("a staging build is the next dev number of the line after production's latest, compiled under it", async () => {
  // dev.2 is unused, but below staging's latest dev.3: numbering starts above it.
  const fake = startFakeOssServer({
    previousLatest: "0.1.5-dev.3\n",
    preexistingKeys: new Set([manifestObjectKey("0.1.5-dev.1"), manifestObjectKey("0.1.5-dev.3")]),
  });

  const { outcome, compiledVersions } = await publishStagingBuild(fake, productionFeed("0.1.4\n"));

  // The version is chosen before compiling: it is baked into the Computer and Daemon binaries.
  expect(compiledVersions).toEqual(["0.1.5-dev.4"]);
  expect(outcome.version).toBe("0.1.5-dev.4");
  expect(stagingLatest(fake)).toBe("0.1.5-dev.4");
});

test("an explicit line starts a new line, and an explicit version is published as named", async () => {
  const raised = startFakeOssServer({ previousLatest: "0.1.5-dev.2\n" });
  const fromLine = await publishStagingBuild(raised, productionFeed("0.1.4"), { line: "0.2.0" });
  expect(fromLine.outcome.version).toBe("0.2.0-dev.1");

  const explicit = startFakeOssServer({ previousLatest: "0.1.5-dev.2\n" });
  await publishStagingBuild(explicit, productionFeed("0.1.4"), { version: "0.1.5-dev.11" });
  expect(stagingLatest(explicit)).toBe("0.1.5-dev.11");
});

test("a staging build off its line or older than staging's latest is refused before it is compiled", async () => {
  for (const [options, refusal] of [
    // A stale line once published 0.1.3-dev.3 after 0.1.4-dev.2.
    [{ version: "0.1.4-dev.3" }, /0\.1\.4-dev\.3 is not a dev build of line 0\.1\.5/],
    [
      { version: "0.1.5-dev.1" },
      /0\.1\.5-dev\.1 is not newer than staging's latest 0\.1\.5-dev\.2/,
    ],
  ] as const) {
    const fake = startFakeOssServer({ previousLatest: "0.1.5-dev.2\n" });
    const compiled: string[] = [];
    await expect(
      runPublish(
        {
          productionFeedUrl: PRODUCTION_FEED,
          commit: "a".repeat(40),
          feedUrl: "https://releases-test.coforge.cn",
          targets: TEST_TARGETS as ReleaseTarget[],
          bucket: BUCKET,
          endpoint: fake.baseUrl,
          region: REGION,
          dryRun: false,
          ...options,
        },
        {
          compile: (async ({ target }) => {
            compiled.push(target);
            throw new Error("compiled");
          }) as CompileFn,
          credentials: CREDENTIALS,
          connection: { endpoint: fake.baseUrl, cname: true, secure: false },
          fetchImpl: productionFeed("0.1.4"),
        },
      ),
    ).rejects.toThrow(refusal);
    expect(compiled).toEqual([]);
    expect(uploads(fake)).toEqual([]);
  }
});

test("a staging build is refused when production's latest cannot be read, with no fallback line", async () => {
  const fake = startFakeOssServer({ previousLatest: "0.1.5-dev.2\n" });
  const unreachable = (async () => new Response("missing", { status: 404 })) as typeof fetch;
  await expect(publishStagingBuild(fake, unreachable)).rejects.toThrow(
    new RegExp(`${PRODUCTION_FEED}/latest: HTTP 404`),
  );
  await expect(publishStagingBuild(fake, productionFeed("0.1.4-dev.2"))).rejects.toThrow(
    /production latest must be a stable/,
  );
  expect(uploads(fake)).toEqual([]);
});

test("--production-feed-url numbers the staging build and reports it to the workflow", async () => {
  const fake = startFakeOssServer({
    previousLatest: "0.1.5-dev.1\n",
    preexistingKeys: new Set([manifestObjectKey("0.1.5-dev.1")]),
  });
  const outputDirectory = await tempDir("coforge-publish-line-");
  const githubOutput = join(outputDirectory, "github-output");
  const previousEnv = {
    id: process.env.ALIBABA_CLOUD_ACCESS_KEY_ID,
    secret: process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET,
    output: process.env.GITHUB_OUTPUT,
  };
  process.env.ALIBABA_CLOUD_ACCESS_KEY_ID = CREDENTIALS.accessKeyId;
  process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET = CREDENTIALS.accessKeySecret;
  process.env.GITHUB_OUTPUT = githubOutput;
  const originalLog = console.log;
  console.log = () => undefined;

  let exitCode: number;
  try {
    exitCode = await runCli(
      [
        "--production-feed-url",
        PRODUCTION_FEED,
        "--feed-url",
        "https://releases-test.coforge.cn",
        "--bucket",
        BUCKET,
        "--region",
        REGION,
        "--targets",
        TEST_TARGETS.join(","),
        "--commit",
        "a".repeat(40),
      ],
      {
        compile: stubCompile(),
        resolvePhotonWasm: stubResolvePhotonWasm(),
        connection: { endpoint: fake.baseUrl, cname: true, secure: false },
        fetchImpl: productionFeed("0.1.4"),
      },
    );
  } finally {
    console.log = originalLog;
    restoreEnvVar("ALIBABA_CLOUD_ACCESS_KEY_ID", previousEnv.id);
    restoreEnvVar("ALIBABA_CLOUD_ACCESS_KEY_SECRET", previousEnv.secret);
    restoreEnvVar("GITHUB_OUTPUT", previousEnv.output);
  }

  expect(exitCode).toBe(0);
  expect(stagingLatest(fake)).toBe("0.1.5-dev.2");
  expect(await readFile(githubOutput, "utf8")).toBe("version=0.1.5-dev.2\n");
});

test("a line is numbered only against the production feed, which a dry run or split publication cannot read", async () => {
  const originalError = console.error;
  const errors: string[] = [];
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
  try {
    const feed = ["--feed-url", "https://releases-test.coforge.cn", "--targets", "linux-x64"];
    const production = ["--production-feed-url", PRODUCTION_FEED];
    expect(await runCli(["--line", "0.1.1", ...feed])).toBe(1);
    expect(await runCli([...production.slice(0, 1), "http://releases.coforge.cn", ...feed])).toBe(
      1,
    );
    expect(await runCli([...production, ...feed, "--version", "0.1.1-dev.3", "--dry-run"])).toBe(1);
    // A split publication runs one job per platform; each would pick its own number.
    expect(await runCli([...production, ...feed, "--no-activate"])).toBe(1);
    expect(await runCli([...production, ...feed, "--allow-existing"])).toBe(1);
    expect(await runCli([...feed, "--dry-run"])).toBe(1);
    expect(errors).toEqual([
      "publish failed: a release line numbers a staging build: pass --production-feed-url with --line",
      "publish failed: --production-feed-url must be an https:// URL",
      "publish failed: a staging build reads both feeds; a --dry-run takes --version alone",
      "publish failed: a split publication names its version: use --version with --no-activate",
      "publish failed: a split publication names its version: use --version with --allow-existing",
      "publish failed: a publish needs a --version, or a --production-feed-url to number one",
    ]);
  } finally {
    console.error = originalError;
  }
});

/* ------------------------------------------------------------------------------------------- */
/* CLI argument parsing                                                                          */
/* ------------------------------------------------------------------------------------------- */

test("parseTargets defaults to all six release platforms and validates unknown ones", () => {
  expect(parseTargets(undefined)).toEqual([
    "linux-x64",
    "linux-arm64",
    "darwin-x64",
    "darwin-arm64",
    "windows-x64",
    "windows-arm64",
  ]);
  expect(parseTargets("linux-x64, darwin-arm64")).toEqual(["linux-x64", "darwin-arm64"]);
  expect(() => parseTargets("linux-x64,bogus")).toThrow(/unsupported release target: bogus/);
});

test("runCli requires --version (or --production-feed-url) and --feed-url, and rejects a non-https feed URL", async () => {
  const originalError = console.error;
  const errors: string[] = [];
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
  try {
    const feed = ["--feed-url", "https://releases-test.coforge.cn", "--targets", "linux-x64"];
    expect(await runCli([...feed, "--dry-run"])).toBe(1);
    expect(await runCli(["--version", "1.0.0", "--dry-run"])).toBe(1);
    expect(
      await runCli([
        "--version",
        "1.0.0",
        "--feed-url",
        "http://releases-test.coforge.cn",
        "--dry-run",
      ]),
    ).toBe(1);
    expect(errors.some((line) => line.includes("a publish needs a --version"))).toBe(true);
    expect(errors.some((line) => line.includes("--feed-url is required"))).toBe(true);
    expect(errors.some((line) => line.includes("https://"))).toBe(true);
  } finally {
    console.error = originalError;
  }
});

test("regionFromEndpoint reads the region a public OSS endpoint names and nothing else", async () => {
  expect(regionFromEndpoint("oss-cn-beijing.aliyuncs.com")).toBe("oss-cn-beijing");
  expect(regionFromEndpoint("https://oss-cn-beijing-internal.aliyuncs.com")).toBe("oss-cn-beijing");
  expect(regionFromEndpoint("http://127.0.0.1:4567")).toBeUndefined();
  expect(regionFromEndpoint("files.coforge.cn")).toBeUndefined();
  // Transfer acceleration endpoints are global and name no region.
  expect(regionFromEndpoint("oss-accelerate.aliyuncs.com")).toBeUndefined();
  expect(regionFromEndpoint("https://oss-accelerate-overseas.aliyuncs.com")).toBeUndefined();
  await expect(
    createOssClient(
      { bucket: BUCKET, endpoint: "http://127.0.0.1:4567", cname: true },
      CREDENTIALS,
    ),
  ).rejects.toThrow("cannot derive the OSS region");
});

test("a transport failure names its class, and still leaks nothing else", () => {
  // The OSS SDK's own message and response body are never surfaced (a `SignatureDoesNotMatch` echoes
  // the signature material back), but the error's *class* is a kind, not content - and it is the only
  // diagnosis a transport failure has, since it reports no status at all.
  const timeout = ossError("upload", "1.2.3/darwin-arm64/coforge-computer.gz", {
    name: "ResponseTimeoutError",
    message: "ResponseTimeoutError: connect ETIMEDOUT 1.2.3.4:443",
  });
  expect(timeout.message).toContain("ResponseTimeoutError");
  expect(timeout.message).toContain("HTTP unknown");
  expect(timeout.message).not.toContain("1.2.3.4");

  const plain = ossError("upload", "key", new Error("Signature=abc123 AccessKeyId=LTAI-secret"));
  expect(plain.message).not.toContain("Signature=abc123");
  expect(plain.message).not.toContain("LTAI-secret");
  // A bare `Error` says nothing, so it is not printed as if it were a diagnosis.
  expect(plain.message).not.toContain(" Error ");
});

test("the publish client keeps ali-oss's documented defaults", async () => {
  // Transfer acceleration fixed the slow cross-border link, so uploads use ali-oss's documented
  // 60 s request timeout and its default keep-alive agent instead of batch-job overrides.
  const connection = fixtureConnection({ url: "https://oss.example" });
  const client = await createOssClient(connection, CREDENTIALS);
  const options = (
    client as unknown as { options: { timeout?: number; agent?: unknown; httpsAgent?: unknown } }
  ).options;
  expect(options.timeout).toBe(60_000);
  expect(options.agent).toBeUndefined();
  expect(options.httpsAgent).toBeUndefined();
});

test("an objects-only publication uploads its files and never touches latest", async () => {
  // The per-platform half of a split publication: parallel jobs must not move the feed's only mutable
  // object, because docs/release/local-distribution.md requires `latest` to be written last and
  // never to point at an incomplete version. The finalize job moves it once every platform's
  // objects are up.
  const outputDirectory = await tempDir("coforge-publish-objects-only-");
  const tree = await fixtureTree("9.9.9-objects-only", outputDirectory);
  const fake = startFakeOssServer({});
  const connection = fixtureConnection(fake);
  const client = await createOssClient(connection, CREDENTIALS);

  const result = await uploadReleaseTree(outputDirectory, tree, {
    client,
    connection,
    activate: false,
  });

  // Every object except the manifest: its content is a hash of *all* targets, and each platform job
  // compiles only its own, so writing it here would race five others with an incomplete marker.
  expect(result.uploaded.length).toBe(tree.files.length - 1);
  expect(fake.calls.some((call) => call.key === LATEST_OBJECT_KEY)).toBe(false);
  // Scoped to writes: reading the manifest is expected (it is the completion marker the *next* publish
  // probes). Writing it is what the objects-only job must not do.
  expect(
    fake.calls.some((call) => call.method === "PUT" && call.key.endsWith("manifest.json")),
  ).toBe(false);
  // The objects themselves still went up, and were verified by reading them back.
  expect(fake.calls.filter((call) => call.method === "PUT").length).toBeGreaterThan(0);
});

test("a finalize pass verifies an already-uploaded version and writes only the manifest and latest", async () => {
  // The two-phase publication end to end: the per-platform jobs put the objects up and touch neither
  // the manifest (their own copy would be incomplete - each compiles one target) nor `latest`; the
  // finalize job recompiles the same tree, verifies every object against those bytes, writes the one
  // true manifest, and only then moves `latest`.
  const outputDirectory = await tempDir("coforge-publish-finalize-");
  const tree = await fixtureTree("9.9.9-finalize", outputDirectory);
  const manifestKey = `9.9.9-finalize/manifest.json`;
  const fake = startFakeOssServer({});
  const connection = fixtureConnection(fake);
  const client = await createOssClient(connection, CREDENTIALS);

  const platform = await uploadReleaseTree(outputDirectory, tree, {
    client,
    connection,
    activate: false,
  });
  const platformPuts = fake.calls.filter(
    (call) => call.method === "PUT" && call.key !== LATEST_OBJECT_KEY,
  );
  expect(platformPuts.some((call) => call.key === manifestKey)).toBe(false);
  expect(fake.calls.some((call) => call.key === LATEST_OBJECT_KEY)).toBe(false);
  expect(platform.uploaded.length).toBe(tree.files.length - 1);

  const finalize = await uploadReleaseTree(outputDirectory, tree, {
    client,
    connection,
    allowExisting: true,
  });

  const finalizePuts = fake.calls
    .filter((call) => call.method === "PUT" && call.key !== LATEST_OBJECT_KEY)
    .slice(platformPuts.length);
  // No data object is rewritten: they are verified against the freshly compiled bytes, not re-uploaded.
  expect(finalizePuts.map((call) => call.key)).toEqual([manifestKey]);
  expect(fake.calls.some((call) => call.key === LATEST_OBJECT_KEY)).toBe(true);
  expect(finalize.uploaded.length).toBe(tree.files.length);
});

/* ------------------------------------------------------------------------------------------- */
/* 6. The installer gate: a release cannot outrun the installer that installs it                */
/* ------------------------------------------------------------------------------------------- */

/** An installer manifest as `installer/<version>/manifest.json` holds it; the gate reads only its
 * version and protocol. */
function installerManifestJson(version: string, installerProtocol: number): string {
  return JSON.stringify({
    schema_version: 1,
    version,
    commit: "a".repeat(40),
    buildDate: "2026-09-30T00:00:00.000Z",
    installer_protocol: installerProtocol,
    platforms: {},
  });
}

/** Builds the release tree, then has its manifest say what a release that needs an installer would:
 * `build-release.ts` does not write `installer_protocol` yet, so this is the only way to exercise
 * the gate end to end. */
function buildTreeRequiring(installerProtocol: number): PublishDependencies["buildTree"] {
  return async (inputs, directory) => {
    const tree = await buildReleaseTree(inputs, directory);
    const path = join(directory, manifestObjectKey(tree.version));
    const manifest = JSON.parse(await readFile(path, "utf8")) as object;
    await writeFile(
      path,
      `${JSON.stringify({ ...manifest, installer_protocol: installerProtocol }, null, 2)}\n`,
    );
    return tree;
  };
}

async function publishGated(
  fake: ReturnType<typeof startFakeOssServer>,
  deps: Partial<PublishDependencies> = {},
  options: Partial<PublishOptions> = {},
) {
  const logs: string[] = [];
  const outcome = await runPublish(
    {
      version: "9.9.9-gate",
      commit: "a".repeat(40),
      feedUrl: "https://releases-test.coforge.cn",
      targets: TEST_TARGETS as ReleaseTarget[],
      bucket: BUCKET,
      endpoint: fake.baseUrl,
      region: REGION,
      dryRun: false,
      ...options,
    },
    {
      compile: stubCompile(),
      resolvePhotonWasm: stubResolvePhotonWasm(),
      credentials: CREDENTIALS,
      connection: { endpoint: fake.baseUrl, cname: true, secure: false },
      log: (line) => logs.push(line),
      ...deps,
    },
  );
  return { outcome, logs };
}

const installerReads = (fake: ReturnType<typeof startFakeOssServer>) =>
  fake.calls.filter((call) => call.key.startsWith("installer/"));

test("a release that needs a newer installer protocol than installer/latest speaks is refused before any object is uploaded", async () => {
  const fake = startFakeOssServer({
    previousLatest: "9.9.8\n",
    preexistingObjects: {
      "installer/latest": "0.3.0\n",
      "installer/0.3.0/manifest.json": installerManifestJson("0.3.0", 1),
    },
  });

  await expect(publishGated(fake, { buildTree: buildTreeRequiring(2) })).rejects.toThrow(
    /9\.9\.9-gate needs installer protocol 2.*pointer_only=<installer version>/s,
  );

  // Nothing was written, so the version is not burnt: it can be published again once an installer
  // speaks protocol 2, and the product pointer never moved.
  expect(fake.calls).toEqual([
    { method: "GET", key: "installer/latest" },
    { method: "GET", key: "installer/0.3.0/manifest.json" },
  ]);
  expect(new TextDecoder().decode(fake.peek(LATEST_OBJECT_KEY))).toBe("9.9.8\n");
});

test("a release the installer covers is published and its pointer moves", async () => {
  const fake = startFakeOssServer({
    preexistingObjects: {
      "installer/latest": "0.3.0\n",
      "installer/0.3.0/manifest.json": installerManifestJson("0.3.0", 2),
    },
  });

  const { outcome, logs } = await publishGated(fake, { buildTree: buildTreeRequiring(2) });

  expect(outcome.version).toBe("9.9.9-gate");
  expect(new TextDecoder().decode(fake.peek(LATEST_OBJECT_KEY))).toBe("9.9.9-gate\n");
  expect(logs.some((line) => line.startsWith("installer gate:") && line.includes("0.3.0"))).toBe(
    true,
  );
});

test("a release that needs an installer is refused while the installer feed is empty", async () => {
  const fake = startFakeOssServer();

  await expect(publishGated(fake, { buildTree: buildTreeRequiring(1) })).rejects.toThrow(
    /no installer is published/,
  );

  expect(fake.calls.some((call) => call.method === "PUT")).toBe(false);
});

test("a release that declares no installer protocol is published without reading the installer feed", async () => {
  const fake = startFakeOssServer();

  const { logs } = await publishGated(fake);

  // Today's releases: build-release.ts writes no installer_protocol, and nothing may block them.
  expect(new TextDecoder().decode(fake.peek(LATEST_OBJECT_KEY))).toBe("9.9.9-gate\n");
  expect(installerReads(fake)).toEqual([]);
  expect(logs).toContain(
    "installer gate: release 9.9.9-gate declares no installer_protocol, so no installer is required",
  );
});

test("a publication that leaves latest alone does not consult the installer feed", async () => {
  const fake = startFakeOssServer();

  await publishGated(fake, { buildTree: buildTreeRequiring(9) }, { activate: false });

  // The gate guards the move of `latest`; a per-platform job never makes it.
  expect(installerReads(fake)).toEqual([]);
  expect(fake.peek(LATEST_OBJECT_KEY)).toBeUndefined();
});

/* ------------------------------------------------------------------------------------------- */
/* 7. A product tree always carries exactly one manifest                                         */
/* ------------------------------------------------------------------------------------------- */

test("a product tree without exactly one manifest is refused, whether or not the job moves latest, before anything is uploaded", async () => {
  const outputDirectory = await tempDir("coforge-publish-manifest-count-");
  const tree = await fixtureTree("9.9.9-manifest-count", outputDirectory);
  const manifestKey = manifestObjectKey(tree.version);
  const fake = startFakeOssServer();
  const connection = fixtureConnection(fake);
  const client = await createOssClient(connection, CREDENTIALS);

  // `build-release.ts` writes the manifest into every tree it builds, so a tree that lacks it is a
  // build that went wrong, and an objects-only job must not read that as "leave the manifest out".
  const withoutManifest = { ...tree, files: tree.files.filter((key) => key !== manifestKey) };
  const withTwoManifests = { ...tree, files: [...tree.files, manifestKey] };
  for (const candidate of [withoutManifest, withTwoManifests]) {
    for (const options of [{}, { activate: false }]) {
      await expect(
        uploadReleaseTree(outputDirectory, candidate, { client, connection, ...options }),
      ).rejects.toThrow(/exactly one 9\.9\.9-manifest-count\/manifest\.json/);
    }
  }
  expect(fake.calls).toEqual([]);
});
