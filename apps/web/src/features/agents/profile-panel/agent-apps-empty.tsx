import { Grid01 } from "@untitledui/icons";

import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#src/components/ui/empty";

/** A part of the Apps tab with nothing in it yet: a compact icon, a title and maybe a line more
 * (`docs/design/empty-states.md`, a local area). */
export function AgentAppsEmpty({ title, description }: { title: string; description?: string }) {
  return (
    <Empty className="p-4">
      <EmptyHeader className="mb-0">
        <EmptyMedia variant="icon" className="mb-2">
          <Grid01 aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle className="text-sm">{title}</EmptyTitle>
        {description && <EmptyDescription>{description}</EmptyDescription>}
      </EmptyHeader>
    </Empty>
  );
}
