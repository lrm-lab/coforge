import { afterEach, expect, test } from "bun:test";

import type { ReleaseTarget } from "./compile-targets";
import type { DarwinSigningIdentity } from "./darwin-signing";
import {
  BUCKET,
  CREDENTIALS,
  REGION,
  startFakeOssServer,
  stopFakeOssServers,
} from "./fixtures/fake-oss";
import { runPublish, type CompileFn, type PublishDependencies } from "./publish";

afterEach(() => stopFakeOssServers());

/** Stands in for the macOS host, signing key and certificate a publish with a darwin target needs;
 * `compile` is a stub too, so nothing here signs anything. */
const STUB_IDENTITY: DarwinSigningIdentity = {
  keyPem: "stub-key",
  certificatePath: "stub-certificate.pem",
};

/** A publish of `targets` whose compile stub records what it was given. */
async function publishTargets(
  targets: ReleaseTarget[],
  deps: Pick<PublishDependencies, "resolveDarwinSigning">,
  dryRun = false,
) {
  const fake = startFakeOssServer({});
  const received: Array<{ target: string; sign?: unknown }> = [];
  await runPublish(
    {
      version: "9.9.9-signing",
      commit: "a".repeat(40),
      feedUrl: "https://releases-test.coforge.cn",
      targets,
      bucket: BUCKET,
      endpoint: fake.baseUrl,
      region: REGION,
      dryRun,
    },
    {
      ...deps,
      compile: (async (input) => {
        received.push({ target: input.target, sign: input.sign });
        return { computer: Buffer.from(`#!/bin/sh\n# ${input.target}\n`) };
      }) as CompileFn,
      resolvePhotonWasm: async () => new Uint8Array(Buffer.from("#wasm-fixture\n")),
      credentials: CREDENTIALS,
      connection: { endpoint: fake.baseUrl, cname: true, secure: false },
    },
  );
  return { fake, received };
}

test("a publish with a darwin target resolves the signing identity once and hands every compile the signer", async () => {
  let resolved = 0;
  const { received } = await publishTargets(["linux-x64", "darwin-arm64", "darwin-x64"], {
    resolveDarwinSigning: async () => {
      resolved += 1;
      return STUB_IDENTITY;
    },
  });
  expect(resolved).toBe(1);
  expect(received.map(({ target }) => target)).toEqual(["linux-x64", "darwin-arm64", "darwin-x64"]);
  for (const { sign } of received) expect(sign).toBeFunction();
});

test("a publish without a darwin target needs no signing identity, dry run included", async () => {
  for (const dryRun of [false, true]) {
    const { received } = await publishTargets(
      ["linux-x64", "windows-x64"],
      {
        resolveDarwinSigning: async () => {
          throw new Error("must not be called without a darwin target");
        },
      },
      dryRun,
    );
    expect(received).toEqual([
      { target: "linux-x64", sign: undefined },
      { target: "windows-x64", sign: undefined },
    ]);
  }
});

test("a publish with a darwin target that cannot sign fails before it compiles or touches the feed, dry run included", async () => {
  for (const dryRun of [false, true]) {
    let compiled = 0;
    const fake = startFakeOssServer({});
    await expect(
      runPublish(
        {
          version: "9.9.9-unsigned",
          commit: "a".repeat(40),
          feedUrl: "https://releases-test.coforge.cn",
          targets: ["linux-x64", "darwin-arm64"],
          bucket: BUCKET,
          endpoint: fake.baseUrl,
          region: REGION,
          dryRun,
        },
        {
          compile: (async () => {
            compiled += 1;
            throw new Error("compiled");
          }) as CompileFn,
          resolveDarwinSigning: async () => {
            throw new Error("COFORGE_DARWIN_SIGNING_KEY is not set");
          },
          credentials: CREDENTIALS,
          connection: { endpoint: fake.baseUrl, cname: true, secure: false },
        },
      ),
    ).rejects.toThrow("COFORGE_DARWIN_SIGNING_KEY is not set");
    expect(compiled).toBe(0);
    expect(fake.calls).toEqual([]);
  }
});
