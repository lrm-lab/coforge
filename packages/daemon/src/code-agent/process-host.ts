import type { ProcessTreeSpawner } from "@lrm/coforge-anvil";
import { ProcessTreeOwner } from "#src/platform/process-tree";

/** Each invocation creates the original platform owner and one independently owned process tree. */
export const processSpawner: ProcessTreeSpawner = {
  spawn: (command, cwd, environment, options) =>
    new ProcessTreeOwner().spawn(command, cwd, environment, options),
};
