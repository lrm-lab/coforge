import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "#src/components/layout/page-header";
import { PageLoadError } from "#src/features/errors/page-load-error";
import { MemoryPanel } from "#src/features/platform-memory/memory-panel";
import { m } from "#src/paraglide/messages";

export const Route = createFileRoute("/w/$workspaceSlug/memory")({
  errorComponent: PageLoadError,
  component: TeamMemoryPage,
});

function TeamMemoryPage() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader heading={m.memory_team()} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl">
          <MemoryPanel canReadPersonal={false} />
        </div>
      </div>
    </div>
  );
}
