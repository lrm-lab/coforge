import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { run } from "./darwin-signing";

export type GeneratedIdentity = { keyPem: string; certificatePem: string };

/** One self-signed certificate usable only for code signing, and its RSA key. `openssl` runs in a
 * scratch directory that is removed afterwards, key included. */
export async function generateSigningIdentity(options: {
  commonName: string;
  days: number;
}): Promise<GeneratedIdentity> {
  const directory = await mkdtemp(join(tmpdir(), "coforge-signing-identity-"));
  try {
    const configPath = join(directory, "openssl.cnf");
    const keyPath = join(directory, "key.pem");
    const certificatePath = join(directory, "cert.pem");
    await writeFile(
      configPath,
      [
        "[req]",
        "distinguished_name = dn",
        "x509_extensions = ext",
        "prompt = no",
        "[dn]",
        `CN = ${options.commonName}`,
        "[ext]",
        "basicConstraints = critical,CA:false",
        "keyUsage = critical,digitalSignature",
        "extendedKeyUsage = critical,codeSigning",
        "",
      ].join("\n"),
    );
    await run("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certificatePath,
      "-days",
      String(options.days),
      "-config",
      configPath,
    ]);
    return {
      keyPem: await Bun.file(keyPath).text(),
      certificatePem: await Bun.file(certificatePath).text(),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
