import type { PerTurnSessionHost } from "@lrm/coforge-anvil";
import { agentEnvironment } from "./environment";
import { ProcessTreeOwner } from "#src/platform/process-tree";

/** Platform capabilities shared by the per-turn adapters; each spawn owns its own tree. */
export const perTurnSessionHost: PerTurnSessionHost = {
  processTreeSpawner: {
    spawn: (command, cwd, environment) => new ProcessTreeOwner().spawn(command, cwd, environment),
  },
  buildEnvironment(options, policy) {
    const sanitize = policy.sanitizeEnvironment;
    const declared = options.environment;
    return {
      ...agentEnvironment(
        sanitize && declared ? sanitize(declared) : declared,
        sanitize ? sanitize(Bun.env) : Bun.env,
        undefined,
        { envVars: options.runtime?.envVars, gitHooks: options.gitHooks },
      ),
      ...policy.environment,
    };
  },
};
