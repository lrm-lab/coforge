import type { DaemonRuntimeLifecycle } from "./runtime-lifecycle";
import type { RuntimeServices } from "./runtime-services-composition";
import {
  startupPublications,
  type RuntimeStartupPublicationsDeps,
} from "./runtime-startup-publications";
import { RuntimeStartup, type RuntimeStartupPorts } from "./runtime-startup";
import { startupLifecycle } from "./runtime-upgrade-lifecycle";

type RuntimeStartupAssemblyPorts = Omit<
  RuntimeStartupPorts,
  "publications" | "lifecycle" | "upgradeResults" | "quotaState" | "reminders" | "procJobs"
> &
  Pick<RuntimeStartupPublicationsDeps, "handlers" | "controlIntentPorts" | "sync"> & {
    workspaceId: string;
    lifecycle: DaemonRuntimeLifecycle;
    services: Pick<RuntimeServices, "upgradeResults" | "quotaState" | "procJobs"> &
      RuntimeStartupPublicationsDeps["services"];
  };

export function assembleRuntimeStartup({
  workspaceId,
  handlers,
  controlIntentPorts,
  lifecycle,
  services,
  sync,
  ...ports
}: RuntimeStartupAssemblyPorts): RuntimeStartup {
  return new RuntimeStartup({
    ...ports,
    publications: startupPublications({
      handlers,
      controlIntentPorts,
      lifecycle,
      services,
      sync,
      readyRunningAgentIds: ports.readyRunningAgentIds,
    }),
    upgradeResults: services.upgradeResults,
    quotaState: services.quotaState,
    lifecycle: startupLifecycle(lifecycle, services.upgradeResults, workspaceId),
    reminders: services.reminders,
    procJobs: services.procJobs,
  });
}
