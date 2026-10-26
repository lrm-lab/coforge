import { DARWIN_SIGNING_KEY_ENV, signDarwinExecutable } from "../darwin-signing";
import { compileTargetArtifacts, isReleaseTarget } from "../compile-targets";

// Compiles one darwin Computer the way a publish does - signed by a closure over the identity -
// and prints the SHA-256 of the bytes `compileTargetArtifacts` returned. The key arrives in the
// environment, never in argv. Run in its own process, outside bun:test, like every release build.
const [target, version, feedUrl, outputDirectory, certificatePath] = process.argv.slice(2);
const keyPem = Bun.env[DARWIN_SIGNING_KEY_ENV];
if (!target || !isReleaseTarget(target) || !version || !feedUrl || !outputDirectory) {
  throw new Error(
    "usage: compile-signed-computer <target> <version> <feed-url> <output-directory> <certificate>",
  );
}
if (!certificatePath || !keyPem)
  throw new Error(`a certificate path and ${DARWIN_SIGNING_KEY_ENV} are required`);

const { computer } = await compileTargetArtifacts({
  target,
  version,
  feedUrl,
  outputDirectory,
  sign: (executable) => signDarwinExecutable(executable, { keyPem, certificatePath }),
});
console.log(new Bun.CryptoHasher("sha256").update(computer).digest("hex"));
