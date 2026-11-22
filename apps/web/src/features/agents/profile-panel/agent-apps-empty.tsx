import { Grid01 } from "@untitledui/icons";

import { EmptyState } from "#src/components/ui/empty";

export function AgentAppsEmpty({ title, description }: { title: string; description?: string }) {
  return (
    <EmptyState
      className="py-6"
      picture={
        <span className="flex size-10 items-center justify-center rounded-lg bg-secondary text-fg-quaternary ring-1 ring-secondary ring-inset">
          <Grid01 aria-hidden="true" className="size-5" />
        </span>
      }
      title={title}
      description={description}
    />
  );
}
