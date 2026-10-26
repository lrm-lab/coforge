import { createRuntimeAuthAdapter } from "#src/code-agent/registry";
import type { RuntimeAuthProvider } from "@lrm/coforge-anvil";

const status = await createRuntimeAuthAdapter(process.argv[2] as RuntimeAuthProvider, {
  environment: Bun.env,
}).readStatus({ workingDirectory: process.cwd() });
console.log(JSON.stringify(status));
