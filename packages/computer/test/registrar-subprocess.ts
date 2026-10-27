// Runs the real coordinator service registrar against a stand-in installer, so a test can look at
// the processes' own stdout and stderr. argv: <installer path>.
import { createCoordinatorServiceRegistrar } from "#src/release/coordinator-service-registrar";

const [installerPath] = process.argv.slice(2);
if (!installerPath) throw new Error("missing installer path");

await createCoordinatorServiceRegistrar({
  installRoot: "/unused",
  target: "linux-x64",
  feedUrl: "https://releases.example.invalid/",
  obtainInstaller: async () => ({ path: installerPath, version: "0.2.0" }),
}).registerAndStart();
