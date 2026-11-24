import { rm } from "node:fs/promises";
import { compileTargetArtifacts } from "../../scripts/compile-release";
import { isReleaseTarget } from "../../../../scripts/release/compile-targets";
import {
  DARWIN_SIGNING_KEY_ENV,
  darwinSignerFor,
  verifyDarwinCliExecutable,
} from "../../../../scripts/release/darwin-signing";

const [target, version, feedUrl, outputDirectory, certificatePath, failure] = process.argv.slice(2);
const keyPem = Bun.env[DARWIN_SIGNING_KEY_ENV];
if (!target || !isReleaseTarget(target) || !version || !feedUrl || !outputDirectory) {
  throw new Error(
    "usage: compile-signed-computer <target> <version> <feed-url> <output-directory> <certificate> [sign|verify]",
  );
}
if (!certificatePath || !keyPem)
  throw new Error(`a certificate path and ${DARWIN_SIGNING_KEY_ENV} are required`);
const sign = await darwinSignerFor([target], async () => ({ keyPem, certificatePath }));
if (!sign) throw new Error("a Darwin target is required");

const { computer, cli } = await compileTargetArtifacts({
  target,
  version,
  feedUrl,
  outputDirectory,
  sign: async (executable, artifact) => {
    if (artifact === "cli" && failure === "sign") await rm(executable);
    await sign(executable, artifact);
    if (artifact === "cli" && failure === "verify") {
      const bytes = new Uint8Array(await Bun.file(executable).arrayBuffer());
      bytes[Math.floor(bytes.length / 2)] ^= 0xff;
      await Bun.write(executable, bytes);
      await verifyDarwinCliExecutable(executable);
    }
  },
});
const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
console.log(JSON.stringify({ computer: sha256(computer), cli: sha256(cli) }));
