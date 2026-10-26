import type { JsonlCatalogHost } from "@lrm/coforge-anvil/execution";
import { processSpawner } from "./process-host";
import { agentEnvironment } from "./environment";

export const jsonlCatalogHost: JsonlCatalogHost = {
  processTreeSpawner: processSpawner,
  buildCatalogEnvironment: (environment) => agentEnvironment(undefined, environment),
};
