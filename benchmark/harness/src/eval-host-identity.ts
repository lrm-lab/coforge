import { join } from "node:path";
import { tmpdir } from "node:os";

/** The names one benchmark's eval computer registers and keeps its daemon state under, derived
 * from the benchmark's short label (`lme`, `sb`, `pcm`). */
export function evalHostIdentity(label: string, workspaceId: string) {
  return {
    name: `${label}-eval-host`,
    displayName: `${label.toUpperCase()} Eval Host`,
    registrationIdempotencyKey: `${label}-eval-${workspaceId}`,
    stateDirectory: join(tmpdir(), `${label}-daemon-${workspaceId.slice(0, 8)}`),
  };
}
