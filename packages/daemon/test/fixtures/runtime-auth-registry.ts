import { createRuntimeAuthAdapter } from "#src/code-agent/registry";
import type { RuntimeAuthProvider } from "@lrm/coforge-anvil";

const provider = process.argv[2] as RuntimeAuthProvider;
const environment =
  provider === "claude-code" ? { ...Bun.env, PATH: Bun.env.AUTH_FIXTURE_DISCOVERY_PATH } : Bun.env;
const status = await createRuntimeAuthAdapter(provider, {
  environment,
}).readStatus({ workingDirectory: process.cwd() });
console.log(JSON.stringify(status));
