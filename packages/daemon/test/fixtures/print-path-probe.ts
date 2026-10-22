// Stands in for `coforge-computer __print-path <file> <nonce>` in login-shell-path tests.
import { writeLoginShellPathProbe } from "#src/platform/login-shell-path";

await writeLoginShellPathProbe(Bun.argv[3] ?? "", Bun.argv[4] ?? "");
