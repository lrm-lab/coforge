import { lazy, Suspense, type ComponentProps } from "react";

import { Skeleton } from "#src/components/ui/skeleton";
import type { AgentProfilePanel } from "./agent-profile-panel";
import type { PersonProfilePanel } from "../person-profile-panel";

const LazyAgentProfileInner = lazy(() =>
  import("./agent-profile-panel").then((mod) => ({ default: mod.AgentProfilePanel })),
);

const LazyPersonProfileInner = lazy(() =>
  import("../person-profile-panel").then((mod) => ({ default: mod.PersonProfilePanel })),
);

function ProfilePanelFallback() {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 bg-primary p-5">
      <div className="flex items-center gap-3">
        <Skeleton className="size-10 rounded-full" />
        <div className="flex flex-1 flex-col gap-2">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-3 w-20" />
        </div>
      </div>
      <Skeleton className="h-24 w-full rounded-xl" />
      <Skeleton className="h-32 w-full rounded-xl" />
    </div>
  );
}

export function LazyAgentProfilePanel(props: ComponentProps<typeof AgentProfilePanel>) {
  return (
    <Suspense fallback={<ProfilePanelFallback />}>
      <LazyAgentProfileInner {...props} />
    </Suspense>
  );
}

export function LazyPersonProfilePanel(props: ComponentProps<typeof PersonProfilePanel>) {
  return (
    <Suspense fallback={<ProfilePanelFallback />}>
      <LazyPersonProfileInner {...props} />
    </Suspense>
  );
}
