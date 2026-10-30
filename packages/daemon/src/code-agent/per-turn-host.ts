import type { PerTurnSessionHost } from "@lrm/coforge-anvil/execution";
import { agentEnvironment } from "./environment";
import { processSpawner } from "./process-host";

/** Platform capabilities shared by the per-turn adapters; each spawn owns its own tree. */
export const perTurnSessionHost: PerTurnSessionHost = {
  processTreeSpawner: processSpawner,
  buildEnvironment(options, policy) {
    const sanitize = policy.sanitizeEnvironment;
    const declared = options.environment;
    return {
      ...agentEnvironment(
        sanitize && declared ? sanitize(declared) : declared,
        sanitize ? sanitize(Bun.env) : Bun.env,
        undefined,
        {
          envVars: options.runtime?.envVars,
          provider: options.runtime?.provider,
          gitHooks: options.gitHooks,
        },
      ),
      ...policy.environment,
    };
  },
};
